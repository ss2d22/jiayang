// A client for the Jiayang Cloud API: deploy, share, read the audit log and manage tokens from code.

export { Jiayang, VERSION } from "./client.js";
export type { Answer, ClientOptions, RequestSpec } from "./client.js";
export type { DeployOptions, Lockfile, ScanInput } from "./deploy.js";
export {
	ApiError,
	AuthenticationError,
	BadRequestError,
	ConfigError,
	ConflictError,
	ConnectionFailedError,
	DeployFailedError,
	JiayangError,
	NotFoundError,
	PayloadTooLargeError,
	PermissionDeniedError,
	PlanLimitError,
	RateLimitError,
	RequestTimeoutError,
	ServerError,
} from "./errors.js";
export type * from "./types.js";
