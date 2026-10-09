// Adapted from @deepseek-ai/dsh-web-fetch-http 0.2.0-rc.2 (MIT).
// See THIRD_PARTY_NOTICES.md. Kept local because these helpers are not exported.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { WebError } from "@deepseek-ai/dsh-web";
const RFC6052_PREFIX_LENGTHS = [
	32,
	40,
	48,
	56,
	64,
	96
];
const IPV4ONLY_DISCOVERY_HOST = "ipv4only.arpa";
const IPV4ONLY_SENTINELS = new Set(["192.0.0.170", "192.0.0.171"]);
/**
* Return whether an address is globally reachable unicast. IPv4-mapped IPv6 is
* classified by its embedded IPv4 address; transition and translation prefixes
* remain blocked because their eventual IPv4 destination cannot be pinned here.
*
* @param input - textual IPv4 or IPv6 address.
* @returns true only for a public unicast destination.
*/
function isPublicIpAddress(input) {
	let parsed;
	try {
		parsed = ipaddr.parse(stripIpv6Brackets(input));
	} catch {
		return false;
	}
	if (parsed instanceof ipaddr.IPv4) return parsed.range() === "unicast";
	if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === "unicast";
	return parsed.range() === "unicast";
}
/**
* Resolve a hostname once and reject the complete answer set if any destination
* is not public. The returned addresses are the only ones the transport may use.
*
* @param hostname - URL hostname, including brackets when it is an IPv6 literal.
* @param signal - aborts the wait for system resolution; an in-flight OS lookup may finish unused.
* @param resolver - lookup implementation, overridden only by focused tests.
* @returns the validated, non-empty address set.
*/
async function resolvePublicAddresses(hostname, signal, resolver = lookup) {
	const unbracketed = stripIpv6Brackets(hostname);
	const literalFamily = isIP(unbracketed);
	const resolved = literalFamily === 0 ? await raceWithSignal(resolver(unbracketed, {
		all: true,
		order: "verbatim"
	}), signal) : [{
		address: unbracketed,
		family: literalFamily
	}];
	if (resolved.length === 0) throw new WebError(`hostname "${hostname}" resolved to no addresses`, "WEB_PROVIDER_ERROR");
	const nat64Prefixes = resolved.some((entry) => entry.family === 6 && isIP(entry.address) === 6) ? await discoverNat64Prefixes(signal, resolver) : [];
	const addresses = [];
	for (const entry of resolved) {
		if (entry.family !== 4 && entry.family !== 6 || isIP(entry.address) !== entry.family) throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, "WEB_PROVIDER_ERROR");
		if (!isPublicIpAddress(entry.address)) throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, "WEB_BLOCKED_URL");
		const translatedIpv4 = translatedIpv4Address(entry.address, nat64Prefixes);
		if (translatedIpv4 !== void 0 && !isPublicIpAddress(translatedIpv4)) throw new WebError(`URL hostname "${hostname}" resolves through NAT64 to a non-public IPv4 address`, "WEB_BLOCKED_URL");
		addresses.push({
			address: entry.address,
			family: entry.family
		});
	}
	return addresses;
}
/** Discover the active DNS64 prefix set using RFC 7050's reserved hostname. */
async function discoverNat64Prefixes(signal, resolver) {
	const discovered = await raceWithSignal(resolver(IPV4ONLY_DISCOVERY_HOST, {
		all: true,
		order: "verbatim"
	}), signal);
	const prefixes = [];
	const seen = /* @__PURE__ */ new Set();
	for (const entry of discovered) {
		if (entry.family !== 6 || isIP(entry.address) !== 6) continue;
		const bytes = ipaddr.parse(entry.address).toByteArray();
		for (const length of RFC6052_PREFIX_LENGTHS) {
			const embedded = embeddedIpv4Address(bytes, length);
			if (embedded === void 0 || !IPV4ONLY_SENTINELS.has(embedded)) continue;
			const prefixBytes = bytes.slice(0, length / 8);
			const key = `${String(length)}:${prefixBytes.join(".")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			prefixes.push({
				bytes: prefixBytes,
				length
			});
		}
	}
	return prefixes;
}
/** Return the RFC 6052-embedded IPv4 address when an IPv6 address matches a discovered prefix. */
function translatedIpv4Address(input, prefixes) {
	if (isIP(input) !== 6) return void 0;
	const bytes = ipaddr.parse(input).toByteArray();
	for (const prefix of prefixes) {
		if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue;
		const embedded = embeddedIpv4Address(bytes, prefix.length);
		if (embedded !== void 0) return embedded;
	}
}
/** Extract one IPv4 address from an RFC 6052 IPv6 layout. */
function embeddedIpv4Address(bytes, prefixLength) {
	if (prefixLength === 96) return bytes.slice(12, 16).join(".");
	if (bytes[8] !== 0) return void 0;
	const prefixBytes = prefixLength / 8;
	const beforeReservedOctet = 8 - prefixBytes;
	return [...bytes.slice(prefixBytes, prefixBytes + beforeReservedOctet), ...bytes.slice(9, 13 - beforeReservedOctet)].join(".");
}
function createPinnedLookup(addresses) {
	return (hostname, options, callback) => {
		const family = typeof options.family === "number" ? options.family : options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : 0;
		const eligible = family === 0 ? addresses : addresses.filter((address) => address.family === family);
		const selected = eligible[0];
		if (selected === void 0) {
			callback(Object.assign(/* @__PURE__ */ new Error(`no validated address for ${hostname} in family ${family}`), {
				code: "ENOTFOUND",
				hostname
			}), options.all === true ? [] : "", family);
			return;
		}
		if (options.all === true) {
			callback(null, eligible.map((address) => ({ ...address })));
			return;
		}
		callback(null, selected.address, selected.family);
	};
}
/** Race a non-cancellable OS lookup without letting it delay tool cancellation. */
function raceWithSignal(promise, signal) {
	const abortError = () => new Error("web fetch aborted during hostname resolution", { cause: signal.reason });
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise((resolve, reject) => {
		const abort = () => {
			reject(abortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", abort);
		});
	});
}
/** WHATWG URL retains brackets around IPv6 hostnames; IP parsers do not. */
function stripIpv6Brackets(hostname) {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export { resolvePublicAddresses, isPublicIpAddress, createPinnedLookup };
