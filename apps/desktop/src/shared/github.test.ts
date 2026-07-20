import { describe, expect, it } from "vitest";
import {
  buildGitCredentialEnv,
  defaultPrTitle,
  deviceFlowErrorText,
  parseGitHubRemote,
  pollDeviceFlow,
  repoNameFromFolder,
} from "./github";

describe("parseGitHubRemote", () => {
  it("parses https, with and without .git", () => {
    expect(parseGitHubRemote("https://github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubRemote("https://github.com/Owner/My-Repo")).toEqual({ owner: "Owner", repo: "My-Repo" });
    expect(parseGitHubRemote("https://github.com/owner/repo/")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("parses ssh shapes", () => {
    expect(parseGitHubRemote("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubRemote("git@github.com:owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseGitHubRemote("ssh://git@github.com/owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("anything not github.com → null", () => {
    expect(parseGitHubRemote("https://gitlab.com/owner/repo.git")).toBeNull();
    expect(parseGitHubRemote("git@bitbucket.org:owner/repo.git")).toBeNull();
    expect(parseGitHubRemote("https://github.com.evil.com/owner/repo")).toBeNull();
    expect(parseGitHubRemote("file:///C:/dev/bare.git")).toBeNull();
    expect(parseGitHubRemote("")).toBeNull();
  });
});

describe("defaultPrTitle", () => {
  it("prefers the last commit subject", () => {
    expect(defaultPrTitle("добавить панель git", "feature/git")).toBe("добавить панель git");
  });
  it("falls back to the branch name", () => {
    expect(defaultPrTitle("", "feature/git")).toBe("feature/git");
    expect(defaultPrTitle(null, "feature/git")).toBe("feature/git");
    expect(defaultPrTitle("   ", "feature/git")).toBe("feature/git");
  });
});

describe("buildGitCredentialEnv", () => {
  const env = buildGitCredentialEnv("gho_secret123");

  it("carries the token ONLY via the env var, never inside a config value", () => {
    expect(env.WELLO_GH_TOKEN).toBe("gho_secret123");
    for (const [key, value] of Object.entries(env)) {
      if (key === "WELLO_GH_TOKEN") continue;
      expect(value).not.toContain("gho_secret123");
    }
  });

  it("scopes both entries to github.com (other hosts keep their own helpers)", () => {
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
    // entry 0 clears the inherited helper list (GCM), entry 1 adds ours
    expect(env.GIT_CONFIG_VALUE_0).toBe("");
    expect(env.GIT_CONFIG_VALUE_1).toContain("$WELLO_GH_TOKEN");
    expect(env.GIT_CONFIG_VALUE_1).toContain("username=x-access-token");
  });
});

describe("repoNameFromFolder", () => {
  it("keeps the GitHub-legal part of a mixed name", () => {
    expect(repoNameFromFolder("Лендинг кофейни Mafin")).toBe("Mafin");
    expect(repoNameFromFolder("My Project!")).toBe("My-Project");
    expect(repoNameFromFolder("wello.dev")).toBe("wello.dev");
    expect(repoNameFromFolder("app_v2")).toBe("app_v2");
  });

  it("a fully-Cyrillic folder falls back to empty (the form asks)", () => {
    expect(repoNameFromFolder("Мой проект")).toBe("");
  });

  it("trims separators at the edges and squashes runs", () => {
    expect(repoNameFromFolder("  --demo--  ")).toBe("demo");
    expect(repoNameFromFolder("a  b   c")).toBe("a-b-c");
    expect(repoNameFromFolder("...dots...")).toBe("dots");
  });

  it("caps at GitHub's 100 characters", () => {
    expect(repoNameFromFolder("x".repeat(150))).toHaveLength(100);
  });
});

describe("pollDeviceFlow", () => {
  const sleeps: number[] = [];
  const instantSleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    return Promise.resolve();
  };

  it("keeps polling through authorization_pending, resolves on access_token", async () => {
    const answers = [{ error: "authorization_pending" }, { error: "authorization_pending" }, { access_token: "gho_x" }];
    const res = await pollDeviceFlow("dev", 5, {
      post: () => Promise.resolve(answers.shift()!),
      sleep: instantSleep,
    });
    expect(res).toEqual({ ok: true, accessToken: "gho_x" });
  });

  it("slow_down adds 5 seconds to the interval", async () => {
    sleeps.length = 0;
    const answers = [{ error: "slow_down" }, { error: "authorization_pending" }, { access_token: "t" }];
    await pollDeviceFlow("dev", 5, { post: () => Promise.resolve(answers.shift()!), sleep: instantSleep });
    expect(sleeps).toEqual([5000, 10000, 10000]);
  });

  it("maps the terminal errors", async () => {
    expect(
      await pollDeviceFlow("d", 1, { post: () => Promise.resolve({ error: "access_denied" }), sleep: instantSleep }),
    ).toEqual({ ok: false, code: "access_denied" });
    expect(
      await pollDeviceFlow("d", 1, { post: () => Promise.resolve({ error: "expired_token" }), sleep: instantSleep }),
    ).toEqual({ ok: false, code: "expired_token" });
    expect(
      await pollDeviceFlow("d", 1, { post: () => Promise.reject(new Error("offline")), sleep: instantSleep }),
    ).toEqual({ ok: false, code: "network" });
  });

  it("an abort reads as cancelled", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const res = await pollDeviceFlow("d", 1, {
      post: () => Promise.resolve({ error: "authorization_pending" }),
      sleep: instantSleep,
      signal: ctl.signal,
    });
    expect(res).toEqual({ ok: false, code: "cancelled" });
  });

  it("every error code has human words", () => {
    for (const code of ["access_denied", "expired_token", "network", "cancelled"] as const) {
      expect(deviceFlowErrorText(code)).not.toBe("");
    }
  });
});
