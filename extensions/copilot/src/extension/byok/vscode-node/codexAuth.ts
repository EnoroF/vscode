/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'http';
import { CancellationToken, env, l10n, Uri, window } from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { ILogService } from '../../../platform/log/common/logService';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const CALLBACK_PORT = 1455;
const CALLBACK_HOST = '127.0.0.1';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const SCOPE = 'openid profile email offline_access';
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const ORIGINATOR = 'vscode-copilot';
const SECRET_KEY = 'copilot-codex-oauth-credentials';

/**
 * Persisted OAuth credentials for the Codex (ChatGPT) provider.
 */
export interface CodexCredentials {
	readonly access: string;
	readonly refresh: string;
	/** Absolute expiry time in epoch milliseconds. */
	readonly expires: number;
	readonly accountId: string;
}

/** The login method the user may choose. */
export const enum CodexLoginMethod {
	Browser = 'browser',
	DeviceCode = 'device_code'
}

interface OAuthToken {
	access: string;
	refresh: string;
	expires: number;
}

function base64urlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	const data = new TextEncoder().encode(verifier);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));
	return { verifier, challenge };
}

function createState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function decodeJwtAccountId(accessToken: string): string | undefined {
	try {
		const parts = accessToken.split('.');
		if (parts.length !== 3) {
			return undefined;
		}
		const encodedPayload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const payload = JSON.parse(atob(encodedPayload.padEnd(Math.ceil(encodedPayload.length / 4) * 4, '='))) as { [key: string]: { chatgpt_account_id?: string } };
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function credentialsFromToken(token: OAuthToken): CodexCredentials {
	const accountId = decodeJwtAccountId(token.access);
	if (!accountId) {
		throw new Error(l10n.t('Failed to extract the ChatGPT account ID from the Codex token.'));
	}
	return { access: token.access, refresh: token.refresh, expires: token.expires, accountId };
}

async function readTokenResponse(response: Response, operation: string): Promise<OAuthToken> {
	if (!response.ok) {
		const text = await response.text().catch(() => '');
		throw new Error(`Codex token ${operation} failed (${response.status}): ${text || response.statusText}`);
	}
	const json = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
		throw new Error(`Codex token ${operation} response is missing required fields.`);
	}
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000
	};
}

async function exchangeAuthorizationCode(code: string, verifier: string, redirectUri: string): Promise<OAuthToken> {
	const response = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri
		})
	});
	return readTokenResponse(response, 'exchange');
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthToken> {
	const response = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: CLIENT_ID
		})
	});
	return readTokenResponse(response, 'refresh');
}

function buildAuthorizeUrl(challenge: string, state: string): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', CLIENT_ID);
	url.searchParams.set('redirect_uri', REDIRECT_URI);
	url.searchParams.set('scope', SCOPE);
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', state);
	url.searchParams.set('id_token_add_organizations', 'true');
	url.searchParams.set('codex_cli_simplified_flow', 'true');
	url.searchParams.set('originator', ORIGINATOR);
	return url.toString();
}

const SUCCESS_HTML = '<html><body style="font-family:sans-serif;padding:2rem"><h2>Codex authentication completed</h2><p>You can close this window and return to VS Code.</p></body></html>';
const ERROR_HTML = '<html><body style="font-family:sans-serif;padding:2rem"><h2>Codex authentication failed</h2><p>Please return to VS Code and try again.</p></body></html>';

/**
 * Waits for the OAuth redirect on the local callback server and resolves with the authorization code.
 */
function waitForAuthorizationCode(state: string, token: CancellationToken): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const server = http.createServer((req, res) => {
			try {
				const url = new URL(req.url || '', `http://localhost:${CALLBACK_PORT}`);
				if (url.pathname !== '/auth/callback') {
					res.statusCode = 404;
					res.end();
					return;
				}
				if (url.searchParams.get('state') !== state) {
					res.statusCode = 400;
					res.setHeader('Content-Type', 'text/html; charset=utf-8');
					res.end(ERROR_HTML);
					finish(() => reject(new Error('Codex OAuth state mismatch.')));
					return;
				}
				const code = url.searchParams.get('code');
				if (!code) {
					res.statusCode = 400;
					res.setHeader('Content-Type', 'text/html; charset=utf-8');
					res.end(ERROR_HTML);
					finish(() => reject(new Error('Codex OAuth response is missing the authorization code.')));
					return;
				}
				res.statusCode = 200;
				res.setHeader('Content-Type', 'text/html; charset=utf-8');
				res.end(SUCCESS_HTML);
				finish(() => resolve(code));
			} catch (err) {
				res.statusCode = 500;
				res.end();
				finish(() => reject(err instanceof Error ? err : new Error(String(err))));
			}
		});

		let settled = false;
		const finish = (action: () => void) => {
			if (settled) {
				return;
			}
			settled = true;
			cancelListener.dispose();
			server.close();
			action();
		};

		const cancelListener = token.onCancellationRequested(() => finish(() => reject(new Error('Codex login cancelled.'))));

		server.on('error', (err: NodeJS.ErrnoException) => finish(() => reject(err)));
		server.listen(CALLBACK_PORT, CALLBACK_HOST);
	});
}

interface DeviceAuthInfo {
	deviceAuthId: string;
	userCode: string;
	intervalSeconds: number;
}

async function startDeviceAuth(): Promise<DeviceAuthInfo> {
	const response = await fetch(DEVICE_USER_CODE_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_id: CLIENT_ID })
	});
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new Error(`Codex device code request failed (${response.status})${body ? `: ${body}` : ''}`);
	}
	const json = await response.json() as { device_auth_id?: string; user_code?: string; interval?: number | string };
	const intervalSeconds = typeof json?.interval === 'string' ? Number(json.interval.trim()) : json?.interval;
	if (!json?.device_auth_id || !json.user_code || typeof intervalSeconds !== 'number' || !Number.isFinite(intervalSeconds)) {
		throw new Error('Codex device code response is invalid.');
	}
	return { deviceAuthId: json.device_auth_id, userCode: json.user_code, intervalSeconds: Math.max(1, intervalSeconds) };
}

function sleep(ms: number, token: CancellationToken): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			listener.dispose();
			resolve();
		}, ms);
		const listener = token.onCancellationRequested(() => {
			clearTimeout(timeout);
			reject(new Error('Codex login cancelled.'));
		});
	});
}

async function pollDeviceAuth(device: DeviceAuthInfo, token: CancellationToken): Promise<{ authorizationCode: string; codeVerifier: string }> {
	const deadline = Date.now() + DEVICE_CODE_TIMEOUT_SECONDS * 1000;
	let intervalMs = Math.max(1000, device.intervalSeconds * 1000);
	while (Date.now() < deadline) {
		if (token.isCancellationRequested) {
			throw new Error('Codex login cancelled.');
		}
		const response = await fetch(DEVICE_TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode })
		});
		if (response.ok) {
			const json = await response.json() as { authorization_code?: string; code_verifier?: string };
			if (!json?.authorization_code || !json.code_verifier) {
				throw new Error('Codex device auth token response is invalid.');
			}
			return { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier };
		}
		if (response.status !== 403 && response.status !== 404) {
			const body = await response.text().catch(() => '');
			let errorCode: string | undefined;
			try {
				const json = JSON.parse(body) as { error?: string | { code?: string } };
				errorCode = typeof json?.error === 'object' ? json.error?.code : json?.error;
			} catch {
				// ignore parse errors
			}
			if (errorCode === 'slow_down') {
				intervalMs += 5000;
			} else if (errorCode !== 'deviceauth_authorization_pending') {
				throw new Error(`Codex device auth failed (${response.status})${body ? `: ${body}` : ''}`);
			}
		}
		await sleep(intervalMs, token);
	}
	throw new Error('Codex device login timed out.');
}

/**
 * Handles the OpenAI Codex (ChatGPT) OAuth flow and persists the resulting credentials.
 */
export class CodexAuthService extends Disposable {
	private readonly _onDidChangeCredentials = this._register(new Emitter<void>());
	public readonly onDidChangeCredentials: Event<void> = this._onDidChangeCredentials.event;

	private _cached: CodexCredentials | undefined;
	private _loaded = false;
	private _refreshInFlight: Promise<CodexCredentials | undefined> | undefined;

	constructor(
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@ILogService private readonly _logService: ILogService
	) {
		super();
	}

	private async _load(): Promise<CodexCredentials | undefined> {
		if (!this._loaded) {
			const raw = await this._extensionContext.secrets.get(SECRET_KEY);
			if (raw) {
				try {
					this._cached = JSON.parse(raw) as CodexCredentials;
				} catch {
					this._cached = undefined;
				}
			}
			this._loaded = true;
		}
		return this._cached;
	}

	private async _storeCredentials(credentials: CodexCredentials | undefined): Promise<void> {
		this._cached = credentials;
		this._loaded = true;
		if (credentials) {
			await this._extensionContext.secrets.store(SECRET_KEY, JSON.stringify(credentials));
		} else {
			await this._extensionContext.secrets.delete(SECRET_KEY);
		}
		this._onDidChangeCredentials.fire();
	}

	/**
	 * Returns true when stored credentials exist (they may still need refreshing).
	 */
	public async isSignedIn(): Promise<boolean> {
		return !!(await this._load());
	}

	/**
	 * Returns valid credentials, refreshing the access token when it is close to expiry.
	 * Returns undefined when the user is not signed in.
	 */
	public async getValidCredentials(): Promise<CodexCredentials | undefined> {
		const credentials = await this._load();
		if (!credentials) {
			return undefined;
		}
		// Refresh if expiring within the next minute.
		if (credentials.expires - Date.now() > 60_000) {
			return credentials;
		}
		if (!this._refreshInFlight) {
			this._refreshInFlight = this._refresh(credentials).finally(() => {
				this._refreshInFlight = undefined;
			});
		}
		return this._refreshInFlight;
	}

	private async _refresh(credentials: CodexCredentials): Promise<CodexCredentials | undefined> {
		try {
			const refreshed = credentialsFromToken(await refreshAccessToken(credentials.refresh));
			await this._storeCredentials(refreshed);
			return refreshed;
		} catch (err) {
			this._logService.error(err, 'Codex: failed to refresh OAuth token');
			return credentials;
		}
	}

	/**
	 * Signs the user out by deleting the stored credentials.
	 */
	public async signOut(): Promise<void> {
		await this._storeCredentials(undefined);
	}

	/**
	 * Performs an interactive login using the given method and persists the credentials.
	 */
	public async login(method: CodexLoginMethod, token: CancellationToken): Promise<CodexCredentials> {
		const credentials = method === CodexLoginMethod.DeviceCode
			? await this._loginDeviceCode(token)
			: await this._loginBrowser(token);
		await this._storeCredentials(credentials);
		return credentials;
	}

	private async _loginBrowser(token: CancellationToken): Promise<CodexCredentials> {
		const { verifier, challenge } = await generatePKCE();
		const state = createState();
		const authorizeUrl = buildAuthorizeUrl(challenge, state);

		const codePromise = waitForAuthorizationCode(state, token);
		await env.openExternal(Uri.parse(authorizeUrl));
		const code = await codePromise;
		return credentialsFromToken(await exchangeAuthorizationCode(code, verifier, REDIRECT_URI));
	}

	private async _loginDeviceCode(token: CancellationToken): Promise<CodexCredentials> {
		const device = await startDeviceAuth();
		void window.showInformationMessage(
			l10n.t('To sign in to Codex, open {0} and enter the code: {1}', DEVICE_VERIFICATION_URI, device.userCode),
			l10n.t('Open in Browser')
		).then(selection => {
			if (selection) {
				void env.openExternal(Uri.parse(DEVICE_VERIFICATION_URI));
			}
		});
		const result = await pollDeviceAuth(device, token);
		return credentialsFromToken(await exchangeAuthorizationCode(result.authorizationCode, result.codeVerifier, DEVICE_REDIRECT_URI));
	}
}
