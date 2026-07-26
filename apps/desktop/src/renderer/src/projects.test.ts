import { describe, it, expect } from "vitest";
import { deriveProjects, filterByProject, folderName, projectExists } from "./projects";

type Chat = { id: string; workspacePath: string | null; workspaceName?: string | null; at: number };
const at = (c: Chat): number => c.at;

const chats: Chat[] = [
  { id: "1", workspacePath: "/dev/shop", workspaceName: "shop", at: 300 },
  { id: "2", workspacePath: "/dev/shop", workspaceName: "shop", at: 500 },
  { id: "3", workspacePath: "/dev/landing", workspaceName: "landing", at: 400 },
  { id: "4", workspacePath: null, at: 900 }, // draft: no folder picked yet
];

describe("deriveProjects", () => {
  it("groups chats by folder, newest activity first", () => {
    const p = deriveProjects(chats, at);
    expect(p.map((x) => x.path)).toEqual(["/dev/shop", "/dev/landing"]);
    expect(p[0]!.count).toBe(2);
    expect(p[0]!.lastActivityMs).toBe(500);
    expect(p[1]!.count).toBe(1);
  });

  it("includes the folder just picked, even with no chats in it yet", () => {
    const p = deriveProjects(chats, at, { path: "/dev/fresh", name: "fresh" });
    expect(p[0]!.path).toBe("/dev/fresh");
    expect(p[0]!.count).toBe(0);
  });

  it("does not duplicate the current folder when it already has chats", () => {
    const p = deriveProjects(chats, at, { path: "/dev/shop", name: "shop" });
    expect(p.filter((x) => x.path === "/dev/shop")).toHaveLength(1);
  });

  it("falls back to the folder name when the chat carries none", () => {
    const p = deriveProjects([{ id: "x", workspacePath: "/a/b/api", at: 1 }], at);
    expect(p[0]!.name).toBe("api");
  });

  it("ignores chats with no folder", () => {
    expect(deriveProjects([{ id: "d", workspacePath: null, at: 1 }], at)).toEqual([]);
  });
});

describe("filterByProject", () => {
  it("returns everything for the 'all projects' view", () => {
    expect(filterByProject(chats, null)).toHaveLength(4);
  });

  it("keeps a project's chats and always keeps folderless drafts", () => {
    const shop = filterByProject(chats, "/dev/shop");
    expect(shop.map((c) => c.id)).toEqual(["1", "2", "4"]);
  });
});

describe("projectExists", () => {
  it("treats 'all projects' as always valid and a vanished project as not", () => {
    const p = deriveProjects(chats, at);
    expect(projectExists(p, null)).toBe(true);
    expect(projectExists(p, "/dev/shop")).toBe(true);
    expect(projectExists(p, "/dev/gone")).toBe(false);
  });
});

describe("folderName", () => {
  it("takes the last segment of either slash style", () => {
    expect(folderName("C:\\dev\\shop")).toBe("shop");
    expect(folderName("/home/u/projects/api/")).toBe("api");
    expect(folderName("solo")).toBe("solo");
  });
});
