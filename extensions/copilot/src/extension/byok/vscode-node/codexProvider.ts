/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource, commands, Event, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatProvider, LanguageModelResponsePart2, l10n, PrepareLanguageModelChatModelOptions, Progress, ProgressLocation, ProvideLanguageModelChatResponseOptions, QuickPickItem, window } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKKnownModels, byokKnownModelToAPIInfo, type LMResponsePart, resolveModelInfo } from '../common/byokProvider';
import { CodexAuthService, CodexLoginMethod } from './codexAuth';
import { CodexEndpoint } from './codexEndpoint';

const PROVIDER_NAME = 'Codex';
const PROVIDER_ID = 'codex';
const MANAGE_CODEX_COMMAND_ID = 'github.copilot.codex.manage';
const SHOW_CODEX_MODELS_COMMAND_ID = 'github.copilot.codex.showModels';

/** Endpoint hit by the Codex backend for the Responses API. */
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

/**
 * Fixed set of models exposed by the Codex backend. The backend does not expose
 * a public model list, so these are hard-coded.
 */
const CODEX_MODELS: BYOKKnownModels = {
	'gpt-5.5': {
		name: 'GPT-5.5 (Codex)',
		maxInputTokens: 256_000,
		maxOutputTokens: 64_000,
		toolCalling: true,
		vision: false,
		thinking: true,
		supportsReasoningEffort: ['low', 'medium', 'high', 'xhigh'],
		reasoningEffortFormat: 'responses',
		streaming: true,
		supportedEndpoints: [ModelSupportedEndpoint.Responses]
	},
	'gpt-5.4': {
		name: 'GPT-5.4 (Codex)',
		maxInputTokens: 256_000,
		maxOutputTokens: 64_000,
		toolCalling: true,
		vision: false,
		thinking: true,
		supportsReasoningEffort: ['low', 'medium', 'high', 'xhigh'],
		reasoningEffortFormat: 'responses',
		streaming: true,
		supportedEndpoints: [ModelSupportedEndpoint.Responses]
	}
};

/**
 * Language model provider backed by the OpenAI Codex (ChatGPT) OAuth flow.
 *
 * Models become available once the user signs in via the browser or device-code
 * flow; the access token is refreshed transparently on each request.
 */
export class CodexLMProvider extends Disposable implements LanguageModelChatProvider {
	public static readonly providerName = PROVIDER_NAME;

	private readonly _authService: CodexAuthService;
	private readonly _lmWrapper: CopilotLanguageModelWrapper;
	private readonly _onDidChangeLanguageModelChatInformation = this._register(new Emitter<void>());
	private _didAttemptEnsureConfiguredGroup = false;

	public readonly onDidChangeLanguageModelChatInformation: Event<void> = this._onDidChangeLanguageModelChatInformation.event;

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService
	) {
		super();
		this._authService = this._register(this._instantiationService.createInstance(CodexAuthService));
		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
		this._register(this._authService.onDidChangeCredentials(() => this._onDidChangeLanguageModelChatInformation.fire()));
		this._register(commands.registerCommand(MANAGE_CODEX_COMMAND_ID, async () => {
			if (await this._promptLogin()) {
				this._onDidChangeLanguageModelChatInformation.fire();
			}
		}));
		this._register(commands.registerCommand(SHOW_CODEX_MODELS_COMMAND_ID, async () => {
			const models = await this.provideLanguageModelChatInformation({ silent: false }, CancellationToken.None);
			this._onDidChangeLanguageModelChatInformation.fire();
			void window.showInformationMessage(l10n.t('Codex returned {0} model(s): {1}', models.length, models.map(model => model.name).join(', ')));
		}));
	}

	async provideLanguageModelChatInformation(options: PrepareLanguageModelChatModelOptions, _token: CancellationToken): Promise<LanguageModelChatInformation[]> {
		const signedIn = await this._authService.isSignedIn();
		this._logService.info(`Codex: resolving language models (silent=${options.silent}, signedIn=${signedIn}).`);
		if (!signedIn) {
			if (options.silent) {
				return [];
			}
			const success = await this._promptLogin();
			if (!success) {
				throw new Error(l10n.t('Codex sign-in did not complete.'));
			}
		}
		if (!options.silent) {
			await this._ensureConfiguredGroup();
		}

		const models = Object.entries(CODEX_MODELS).map(([id, capabilities]) => byokKnownModelToAPIInfo(PROVIDER_NAME, id, capabilities));
		this._logService.info(`Codex: providing ${models.length} language model(s).`);
		return models;
	}

	private async _ensureConfiguredGroup(): Promise<void> {
		if (this._didAttemptEnsureConfiguredGroup) {
			return;
		}
		this._didAttemptEnsureConfiguredGroup = true;
		try {
			await commands.executeCommand('lm.addLanguageModelsProviderGroup', { vendor: PROVIDER_ID, name: PROVIDER_NAME });
		} catch (err) {
			this._logService.debug(`Codex: provider group was not added: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async provideLanguageModelChatResponse(model: LanguageModelChatInformation, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {
		const endpoint = await this._createEndpoint(model.id);
		return this._lmWrapper.provideLanguageModelResponse(endpoint, messages, options, options.requestInitiator, progress as Progress<LMResponsePart>, token);
	}

	async provideTokenCount(model: LanguageModelChatInformation, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, _token: CancellationToken): Promise<number> {
		const endpoint = await this._createEndpoint(model.id);
		return this._lmWrapper.provideTokenCount(endpoint, text);
	}

	private async _createEndpoint(modelId: string): Promise<CodexEndpoint> {
		const credentials = await this._authService.getValidCredentials();
		if (!credentials) {
			throw new Error(l10n.t('You are not signed in to Codex. Select a Codex model to sign in.'));
		}
		const modelInfo = resolveModelInfo(modelId, PROVIDER_NAME, CODEX_MODELS);
		return this._instantiationService.createInstance(CodexEndpoint, modelInfo, credentials.access, credentials.accountId, CODEX_RESPONSES_URL);
	}

	private async _promptLogin(): Promise<boolean> {
		const browserItem: QuickPickItem = { label: l10n.t('Sign in with Browser'), detail: l10n.t('Open your browser to authorize Codex') };
		const deviceItem: QuickPickItem = { label: l10n.t('Sign in with Device Code'), detail: l10n.t('Enter a code on another device') };
		const picked = await window.showQuickPick([browserItem, deviceItem], {
			title: l10n.t('Sign in to Codex'),
			placeHolder: l10n.t('Choose how to sign in to Codex')
		});
		if (!picked) {
			return false;
		}
		const method = picked === deviceItem ? CodexLoginMethod.DeviceCode : CodexLoginMethod.Browser;
		return window.withProgress({ location: ProgressLocation.Notification, title: l10n.t('Signing in to Codex...'), cancellable: true }, async (_progress, progressToken) => {
			const cts = new CancellationTokenSource();
			const listener = progressToken.onCancellationRequested(() => cts.cancel());
			try {
				await this._authService.login(method, cts.token);
				return true;
			} catch (err) {
				this._logService.error(err, 'Codex: login failed');
				void window.showErrorMessage(l10n.t('Codex sign-in failed: {0}', err instanceof Error ? err.message : String(err)));
				return false;
			} finally {
				listener.dispose();
				cts.dispose();
			}
		});
	}
}
