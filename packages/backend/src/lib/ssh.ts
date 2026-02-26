import { NodeSSH } from "node-ssh";
import { env } from "./env";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface VM {
  exec: (command: string) => Promise<ExecResult>;
  readJson: <T = Record<string, unknown>>(remotePath: string) => Promise<T>;
  writeJson: (remotePath: string, data: unknown, owner?: string) => Promise<void>;
  restart: (service: string) => Promise<void>;
}

/**
 * Run an async function against a VM over SSH. Connection is opened before `fn`
 * runs and disposed when it finishes (or throws). A hard timeout (default 30s)
 * aborts the entire operation.
 */
export async function withVM<T>(
  ip: string,
  fn: (vm: VM) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  if (!env.SSH_PRIVATE_KEY) {
    throw new Error("SSH_PRIVATE_KEY is not configured");
  }

  const ssh = new NodeSSH();
  const privateKey = Buffer.from(env.SSH_PRIVATE_KEY, "base64").toString("utf8");

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`SSH operation timed out (${timeoutMs}ms)`)), timeoutMs),
  );

  const run = async () => {
    await ssh.connect({
      host: ip,
      port: 22,
      username: "root",
      privateKey,
      readyTimeout: 10_000,
    });

    const exec = async (command: string): Promise<ExecResult> => {
      const r = await ssh.execCommand(command);
      return { stdout: r.stdout, stderr: r.stderr, code: r.code ?? -1 };
    };

    const readJson = async <T = Record<string, unknown>>(remotePath: string): Promise<T> => {
      const { stdout, code, stderr } = await exec(`cat ${remotePath}`);
      if (code !== 0) throw new Error(`Failed to read ${remotePath}: ${stderr}`);
      return JSON.parse(stdout) as T;
    };

    const writeJson = async (remotePath: string, data: unknown, owner?: string): Promise<void> => {
      const json = JSON.stringify(data, null, 2);
      const tmp = `/tmp/ssh-cfg-${Date.now()}.json`;
      // Write via stdin to avoid any shell-escaping issues
      await ssh.execCommand(`cat > ${tmp}`, { stdin: json });
      await exec(`mv ${tmp} ${remotePath}`);
      if (owner) await exec(`chown ${owner}:${owner} ${remotePath}`);
    };

    const restart = async (service: string): Promise<void> => {
      // Gateway is a user-level systemd service (openclaw user); other services are system-level.
      let cmd: string;
      if (service === "openclaw-gateway") {
        const rtdir = "/run/user/$(id -u openclaw)";
        cmd = `sudo -u openclaw XDG_RUNTIME_DIR=${rtdir} DBUS_SESSION_BUS_ADDRESS=unix:path=${rtdir}/bus systemctl --user restart ${service}`;
      } else {
        cmd = `systemctl restart ${service}`;
      }
      const { code, stderr } = await exec(cmd);
      if (code !== 0) throw new Error(`Failed to restart ${service}: ${stderr}`);
    };

    return fn({ exec, readJson, writeJson, restart });
  };

  try {
    return await Promise.race([run(), timeout]);
  } finally {
    ssh.dispose();
  }
}
