/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IChatEndpoint, IEndpointBody } from '../../../platform/networking/common/networking';
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
		// The Codex backend is stateless: it does not persist responses and
		// requires the encrypted reasoning content to be echoed back.
		customized.store = false;
		customized.include = ['reasoning.encrypted_content'];
		return customized;
	}

	public override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const newModelInfo = { ...this.modelMetadata, maxInputTokens: modelMaxPromptTokens };
		return this.instantiationService.createInstance(CodexEndpoint, newModelInfo, this._apiKey, this._accountId, this._modelUrl);
	}
}
