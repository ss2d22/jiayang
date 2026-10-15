import type { PlanLimitHit, Version } from "./types.js";

/** Everything this client throws on purpose is one of these. */
export class JiayangError extends Error {
	override name = "JiayangError";
}

/** The client can't start: no token, a token that isn't for the API, or an address that isn't https. */
export class ConfigError extends JiayangError {
	override name = "ConfigError";
}

/** The request never got an answer: no connection, or it dropped. */
export class ConnectionFailedError extends JiayangError {
	override name = "ConnectionFailedError";
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
	}
}

/** The platform didn't answer in time. A change may still have been made. */
export class RequestTimeoutError extends JiayangError {
	override name = "RequestTimeoutError";
}

/** The platform answered with an error. `code` is its stable name for it, like `not_found`. */
export class ApiError extends JiayangError {
	override name = "ApiError";
	readonly status: number;
	/** Empty when the answer wasn't the platform's own, from a proxy on the way, say. */
	readonly code: string;
	/** Seconds to wait before asking again, when the platform said. */
	readonly retryAfter: number | null;
	/** For tracing a failure on our side. Quote it when you contact support. */
	readonly requestId: string | null;

	constructor(status: number, code: string, message: string, retryAfter: number | null, requestId: string | null) {
		super(message);
		this.status = status;
		this.code = code;
		this.retryAfter = retryAfter;
		this.requestId = requestId;
	}
}

/** 400: the request isn't valid. The message says what to change. */
export class BadRequestError extends ApiError {
	override name = "BadRequestError";
}

/** 401: no session, or one that has ended or been revoked. Sign in again with `jiayang login`. */
export class AuthenticationError extends ApiError {
	override name = "AuthenticationError";
}

/** 403: you can't do this, or a CLI session can't (paying, deleting a workspace). */
export class PermissionDeniedError extends ApiError {
	override name = "PermissionDeniedError";
}

/** 403 `plan_limit` or `contact_sales`: the workspace's plan doesn't allow one more. */
export class PlanLimitError extends PermissionDeniedError {
	override name = "PlanLimitError";
	readonly limit: PlanLimitHit | null;
	constructor(status: number, code: string, message: string, requestId: string | null, limit: PlanLimitHit | null) {
		super(status, code, message, null, requestId);
		this.limit = limit;
	}
}

/** 404: nothing there, or nothing you may see. The platform answers the two the same way. */
export class NotFoundError extends ApiError {
	override name = "NotFoundError";
}

/** 409: it clashes with what's there, like a name in use or a version still going live. */
export class ConflictError extends ApiError {
	override name = "ConflictError";
}

/** 413: the upload is too large. */
export class PayloadTooLargeError extends ApiError {
	override name = "PayloadTooLargeError";
}

/** 429: too many requests for now. `retryAfter` says how long to wait. */
export class RateLimitError extends ApiError {
	override name = "RateLimitError";
}

/** 5xx: a fault on our side or on the way. Reads are tried again before this is thrown. */
export class ServerError extends ApiError {
	override name = "ServerError";
}

/** A deploy whose version didn't go live. `version` says which, and `message` why. */
export class DeployFailedError extends JiayangError {
	override name = "DeployFailedError";
	readonly version: Version;
	constructor(version: Version) {
		super(version.failure ?? `Version ${version.number} was uploaded but couldn't go live.`);
		this.version = version;
	}
}

/** The right class for an error answer. */
export function apiError(
	status: number,
	code: string,
	message: string,
	retryAfter: number | null,
	requestId: string | null,
	limit: PlanLimitHit | null,
): ApiError {
	if (status === 403 && (code === "plan_limit" || code === "contact_sales")) {
		return new PlanLimitError(status, code, message, requestId, limit);
	}
	const type =
		status === 400
			? BadRequestError
			: status === 401
				? AuthenticationError
				: status === 403
					? PermissionDeniedError
					: status === 404
						? NotFoundError
						: status === 409
							? ConflictError
							: status === 413
								? PayloadTooLargeError
								: status === 429
									? RateLimitError
									: status >= 500
										? ServerError
										: ApiError;
	return new type(status, code, message, retryAfter, requestId);
}
