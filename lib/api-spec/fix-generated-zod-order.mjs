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
await writeFile(target, `${source.trimEnd()}\n`);

// Keep regenerated clients free of trailing blank lines as well.
for (const path of [
  "../api-client-react/src/generated/api.ts",
  "../api-client-react/src/generated/api.schemas.ts",
]) {
  const output = new URL(path, import.meta.url);
  const content = await readFile(output, "utf8");
  await writeFile(output, `${content.trimEnd()}\n`);
}