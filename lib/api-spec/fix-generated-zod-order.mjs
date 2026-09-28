import { readFile, writeFile } from "node:fs/promises";

const target = new URL("../api-zod/src/generated/api.ts", import.meta.url);
let source = await readFile(target, "utf8");
for (const [declaration, body] of [
  ["export const reviewMemberStoryRemovalBodyNoteMax = 2000;\n", "export const ReviewMemberStoryRemovalBody = zod.object({"],
  ["export const listAnnouncementsQueryAfterMax = 2147483647;\n", "export const ListAnnouncementsQueryParams = zod.object({"],
]) {
  if (!source.includes(declaration) || !source.includes(body)) {
    throw new Error("Generated schema changed; check the Zod declaration order");
  }
  if (source.indexOf(declaration) > source.indexOf(body)) {
    source = source.replace(declaration, "").replace(body, `${declaration}\n${body}`);
  }
}
await writeFile(target, source);