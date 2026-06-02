/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody } from '../../../platform/networking/common/networking';
import { IChatWebSocketManager } from '../../../platform/networking/node/chatWebSocketManager';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { OpenAIEndpoint } from '../node/openAIEndpoint';

/** Beta header required by the ChatGPT Codex backend. */
const CODEX_OPENAI_BETA = 'responses=experimental';
/** Originator identifier sent to the Codex backend. */
const CODEX_ORIGINATOR = 'vscode-copilot';

/**
 * Chat endpoint for the OpenAI Codex (ChatGPT) backend.
 *
 * It targets the `chatgpt.com/backend-api/codex/responses` Responses API and
 * injects the ChatGPT account and originator headers required by that backend.
 */
export class CodexEndpoint extends OpenAIEndpoint {
	constructor(
		modelMetadata: IChatModelInformation,
		accessToken: string,
		private readonly _accountId: string,
		modelUrl: string,
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@IChatWebSocketManager chatWebSocketService: IChatWebSocketManager,
		@ILogService logService: ILogService
	) {
		super(
			modelMetadata,
			accessToken,
			modelUrl,
			domainService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			expService,
			chatWebSocketService,
			logService
		);
	}

	public override getExtraHeaders(): Record<string, string> {
		return {
			...super.getExtraHeaders(),
			'chatgpt-account-id': this._accountId,
			'originator': CODEX_ORIGINATOR,
			'OpenAI-Beta': CODEX_OPENAI_BETA,
			'accept': 'text/event-stream'
		};
	}

	protected override customizeResponsesBody(body: IEndpointBody): IEndpointBody {
		const customized = super.customizeResponsesBody(body);
		return customizeCodexResponsesBody(customized);
	}

	public override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		return customizeCodexResponsesBody(super.createRequestBody({ ...options, ignoreStatefulMarker: true }));
	}

	public override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const newModelInfo = { ...this.modelMetadata, maxInputTokens: modelMaxPromptTokens };
		return this.instantiationService.createInstance(CodexEndpoint, newModelInfo, this._apiKey, this._accountId, this._modelUrl);
	}
}

function customizeCodexResponsesBody(body: IEndpointBody): IEndpointBody {
	body.instructions = extractCodexInstructions(body.input) ?? body.instructions ?? '';
	// The Codex backend is stateless: it does not persist responses and
	// requires the encrypted reasoning content to be echoed back.
	body.store = false;
	body.include = ['reasoning.encrypted_content'];
	delete body.max_output_tokens;
	delete body.previous_response_id;
	delete body.truncation;
	delete body.context_management;
	delete body.top_logprobs;
	delete body.n;
	delete body.stream_options;
	delete body.reasoning_effort;
	body.tool_choice ??= 'auto';
	body.parallel_tool_calls = true;
	body.text ??= { verbosity: 'low' };
	body.input = sanitizeCodexInput(body.input);
	if (body.prompt_cache_key && body.prompt_cache_key.length > 64) {
		body.prompt_cache_key = body.prompt_cache_key.slice(0, 64);
	}
	return body;
}

function sanitizeCodexInput(input: readonly unknown[] | undefined): readonly unknown[] | undefined {
	if (!input) {
		return input;
	}

	return input.map(item => {
		if (!isObject(item) || item.type !== 'reasoning') {
			return item;
		}

		const reasoningItem: Record<string, unknown> = { ...item };
		delete reasoningItem.id;
		return reasoningItem;
	});
}

function extractCodexInstructions(input: readonly unknown[] | undefined): string | undefined {
	if (!input) {
		return undefined;
	}

	const systemMessages: { content?: unknown }[] = [];
	const remainingInput: unknown[] = [];
	for (const item of input) {
		if (isSystemInputMessage(item)) {
			systemMessages.push(item);
		} else {
			remainingInput.push(item);
		}
	}

	if (!systemMessages.length) {
		return undefined;
	}

	(input as unknown[]).splice(0, input.length, ...remainingInput);
	return systemMessages.map(message => getInputMessageText(message)).filter(text => text.length > 0).join('\n\n');
}

function isSystemInputMessage(item: unknown): item is { role: string; content?: unknown } {
	return isObject(item) && 'role' in item && item.role === 'system';
}

function getInputMessageText(message: { content?: unknown }): string {
	if (!Array.isArray(message.content)) {
		return '';
	}

	return message.content
		.map(part => isObject(part) && 'type' in part && part.type === 'input_text' && 'text' in part && typeof part.text === 'string' ? part.text : '')
		.filter(text => text.length > 0)
		.join('\n');
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
