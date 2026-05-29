import type { CreateMuxError, MuxError, MuxErrorInit } from "./types.js";

export const muxError: CreateMuxError = (init: MuxErrorInit): MuxError => {
	const message = init.message ?? init.code;
	const err = new Error(message) as MuxError;
	err.code = init.code;
	if (init.source !== undefined) err.source = init.source;
	if (init.cause !== undefined) err.cause = init.cause;
	if (init.errors !== undefined) err.errors = init.errors;
	return err;
};
