/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { fromAgentHostUri } from '../../../../platform/agentHost/common/agentHostUri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationNode, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ITextEditorOptions } from '../../../../platform/editor/common/editor.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { extractSelection, IOpener, IOpenerService, OpenOptions } from '../../../../platform/opener/common/opener.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IUserInteractionService } from '../../../../platform/userInteraction/browser/userInteractionService.js';
import { workbenchConfigurationNodeBase } from '../../../common/configuration.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

export class ChatExternalEditorOpenerContribution extends Disposable implements IWorkbenchContribution, IOpener {

	static readonly ID = 'workbench.contrib.chatExternalEditorOpener';

	constructor(
		@IOpenerService openerService: IOpenerService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IUserInteractionService private readonly userInteractionService: IUserInteractionService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(openerService.registerOpener(this));
	}

	async open(target: URI | string, options?: OpenOptions): Promise<boolean> {
		const toolId = this.configurationService.getValue<string>('workbench.externalEditor.defaultTool');
		if (!toolId || toolId === 'none') {
			// No external editor configured; fall through to the default opener.
			return false;
		}

		// Require Ctrl to be held unless the user has opted out; otherwise
		// fall through to the default opener.
		const requireCtrl = this.configurationService.getValue<boolean>('workbench.externalEditor.requireCtrlModifier') !== false;
		if (requireCtrl && !this.userInteractionService.readModifierKeyStatus(mainWindow, undefined).ctrlKey) {
			return false;
		}

		const uri = typeof target === 'string' ? URI.parse(target) : target;
		const { selection, uri: uriWithoutSelection } = extractSelection(uri);
		const editorOptions: ITextEditorOptions | undefined = options?.editorOptions;
		const targetSelection = selection ?? editorOptions?.selection;
		const resource = fromAgentHostUri(uriWithoutSelection);
		if (resource.scheme !== 'file') {
			return false;
		}

		return this.nativeHostService.openInExternalEditor(toolId, resource.fsPath, targetSelection?.startLineNumber);
	}
}

/**
 * Registers and refreshes the `workbench.externalEditor.defaultTool` setting.
 * The list of selectable editors is built on startup by probing the machine for
 * installed editors; only editors whose executable could be resolved are
 * offered. The first available editor is used as the default.
 */
export class ExternalEditorConfigurationContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.externalEditorConfiguration';

	private configurationNode: IConfigurationNode | undefined;

	constructor(
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) {
		super();
		this.refresh();
	}

	private async refresh(): Promise<void> {
		const editors = await this.nativeHostService.getExternalEditors();
		if (this._store.isDisposed) {
			return;
		}

		// Only offer built-in editors whose executable could actually be located;
		// discovered editors that are not part of the predefined list as well as
		// editors whose path could not be resolved are dropped.
		const available = editors.filter(editor => editor.source === 'builtin' && editor.available && editor.path);

		const ids = ['none', ...available.map(editor => editor.id)];
		const itemLabels = [
			localize('workbench.externalEditor.defaultTool.none.label', "None"),
			...available.map(editor => editor.label)
		];

		// The first available editor is the default; if none are installed, fall
		// back to not opening externally.
		const defaultTool = available[0]?.id ?? 'none';

		const configurationNode: IConfigurationNode = {
			...workbenchConfigurationNodeBase,
			'properties': {
				'workbench.externalEditor.defaultTool': {
					type: 'string',
					enum: ids,
					enumItemLabels: itemLabels,
					default: defaultTool,
					markdownDescription: localize('workbench.externalEditor.defaultTool', "The external editor or IDE used to open files from links. The list of available editors is refreshed on startup based on the editors installed on this machine."),
					included: isWindows
				}
			}
		};

		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		if (this.configurationNode) {
			registry.updateConfigurations({ add: [configurationNode], remove: [this.configurationNode] });
		} else {
			registry.registerConfiguration(configurationNode);
		}
		this.configurationNode = configurationNode;
	}
}
