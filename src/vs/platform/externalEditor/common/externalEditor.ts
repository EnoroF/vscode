/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Describes a known external editor / IDE that VS Code can launch a file with.
 * This list is controlled internally; only the user's selection is configurable.
 */
export interface IExternalEditorTool {

	/**
	 * Stable identifier used as the configuration value for the default tool.
	 */
	readonly id: string;

	/**
	 * Human readable label shown in the settings UI.
	 */
	readonly label: string;

	/**
	 * Candidate executable names (lower case) used to look the tool up in the
	 * Windows `App Paths` registry as well as to match discovered editors.
	 */
	readonly exeNames: readonly string[];

	/**
	 * Absolute fallback paths that are probed when the registry lookup fails.
	 */
	readonly fallbackPaths: readonly string[];

	/**
	 * Builds the command line arguments to open the given file (optionally at a
	 * specific line) with this tool.
	 */
	buildArgs(filePath: string, lineNumber?: number): string[];
}

/**
 * The internally controlled list of known external editors.
 */
export const BUILTIN_EXTERNAL_EDITORS: readonly IExternalEditorTool[] = [
	{
		id: 'rider',
		label: 'JetBrains Rider',
		exeNames: ['rider64.exe', 'rider.exe'],
		fallbackPaths: [
			'C:\\Program Files\\JetBrains\\JetBrains Rider\\bin\\rider64.exe'
		],
		buildArgs: (filePath, lineNumber) => lineNumber !== undefined ? ['--line', String(lineNumber), filePath] : [filePath]
	},
	{
		id: 'intellij',
		label: 'JetBrains IntelliJ IDEA',
		exeNames: ['idea64.exe', 'idea.exe'],
		fallbackPaths: [],
		buildArgs: (filePath, lineNumber) => lineNumber !== undefined ? ['--line', String(lineNumber), filePath] : [filePath]
	},
	{
		id: 'visualstudio',
		label: 'Visual Studio',
		exeNames: ['devenv.exe'],
		fallbackPaths: [],
		// Visual Studio's command line does not offer reliable line navigation.
		buildArgs: (filePath) => ['/Edit', filePath]
	},
	{
		id: 'notepadpp',
		label: 'Notepad++',
		exeNames: ['notepad++.exe'],
		fallbackPaths: [
			'C:\\Program Files\\Notepad++\\notepad++.exe',
			'C:\\Program Files (x86)\\Notepad++\\notepad++.exe'
		],
		buildArgs: (filePath, lineNumber) => lineNumber !== undefined ? [`-n${lineNumber}`, filePath] : [filePath]
	}
];

/**
 * A resolved external editor that is safe to transfer over IPC to the renderer.
 */
export interface IResolvedExternalEditor {

	/**
	 * Identifier matching either a built-in tool id or a discovered editor.
	 */
	readonly id: string;

	/**
	 * Human readable label shown in the settings UI.
	 */
	readonly label: string;

	/**
	 * The resolved absolute path of the editor executable, if it could be found.
	 */
	readonly path?: string;

	/**
	 * Whether the editor executable exists on disk.
	 */
	readonly available: boolean;

	/**
	 * Where this editor entry originated from.
	 */
	readonly source: 'builtin' | 'discovered';
}
