import { lookup } from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

/**
 * One-shot connectivity probe that runs at worker startup. Logs each layer
 * (DNS, TCP, TLS, HTTPS) separately so we can tell which one is failing in
 * prod when the poller just prints "fetch failed".
 */
export async function diagnose(): Promise<void> {
  console.log("[diag] starting connectivity probe");

  // Who am I on the internet? Useful if OpenSky is filtering by CIDR.
  await probeFetch("https://api.ipify.org", "ipify (egress IP)");

  // DNS
  let ips: string[] = [];
  try {
    const all = await Promise.all([
      lookup("auth.opensky-network.org", { all: true }),
      lookup("opensky-network.org", { all: true }),
    ]);
    const fmt = (xs: { address: string; family: number }[]) =>
      xs.map((x) => `${x.address}(v${x.family})`).join(",");
    console.log(`[diag] DNS auth.opensky-network.org = ${fmt(all[0])}`);
    console.log(`[diag] DNS opensky-network.org      = ${fmt(all[1])}`);
    ips = all[0].map((x) => x.address);
  } catch (err) {
    console.error(`[diag] DNS error:`, err);
    return;
  }

  // Raw TCP to :443
  for (const ip of ips) {
    await probeTcp(ip, 443);
  }

  // TLS handshake to the hostname on each resolved IP
  for (const ip of ips) {
    await probeTls("auth.opensky-network.org", ip, 443);
  }

  // HTTPS via undici fetch (this is what the real code path uses)
  await probeFetch("https://auth.opensky-network.org/", "auth endpoint root");

  console.log("[diag] probe done");
}

async function probeTcp(host: string, port: number): Promise<void> {
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    const sock = net.createConnection({ host, port, timeout: 15_000 });
    sock.once("connect", () => {
      console.log(`[diag] TCP ${host}:${port} CONNECTED in ${Date.now() - t0}ms`);
      sock.destroy();
      resolve();
    });
    sock.once("timeout", () => {
      console.error(`[diag] TCP ${host}:${port} TIMEOUT after ${Date.now() - t0}ms`);
      sock.destroy();
      resolve();
    });
    sock.once("error", (err) => {
      console.error(
        `[diag] TCP ${host}:${port} ERROR in ${Date.now() - t0}ms: ${(err as { code?: string }).code ?? ""} ${err.message}`,
      );
      resolve();
    });
  });
}

async function probeTls(
  servername: string,
  ip: string,
  port: number,
): Promise<void> {
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    const sock = tls.connect(
      { host: ip, port, servername, timeout: 15_000 },
      () => {
        console.log(
          `[diag] TLS ${servername} via ${ip}:${port} OK in ${Date.now() - t0}ms (cipher=${sock.getCipher()?.name})`,
        );
        sock.end();
        resolve();
      },
    );
    sock.once("timeout", () => {
      console.error(
        `[diag] TLS ${servername} via ${ip}:${port} TIMEOUT after ${Date.now() - t0}ms`,
      );
      sock.destroy();
      resolve();
    });
    sock.once("error", (err) => {
      console.error(
        `[diag] TLS ${servername} via ${ip}:${port} ERROR in ${Date.now() - t0}ms: ${(err as { code?: string }).code ?? ""} ${err.message}`,
      );
      resolve();
    });
  });
}

async function probeFetch(url: string, label: string): Promise<void> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    console.log(
      `[diag] GET ${label} (${url}) HTTP ${res.status} in ${Date.now() - t0}ms body="${body.slice(0, 80)}"`,
    );
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    console.error(
      `[diag] GET ${label} (${url}) FAILED in ${Date.now() - t0}ms: ${e.message} (cause: ${e.cause?.code ?? ""} ${e.cause?.message ?? ""})`,
    );
  }
}
