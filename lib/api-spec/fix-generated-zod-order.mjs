import { readFile, writeFile } from "node:fs/promises";

const target = new URL("../api-zod/src/generated/api.ts", import.meta.url);
const declaration = "export const reviewMemberStoryRemovalBodyNoteMax = 2000;\n";
const body = "export const ReviewMemberStoryRemovalBody = zod.object({";
const source = await readFile(target, "utf8");

if (!source.includes(declaration) || !source.includes(body)) {
  throw new Error("Generated story review schema changed; check the Zod declaration order");
}
if (source.indexOf(declaration) > source.indexOf(body)) {
  const withoutDeclaration = source.replace(declaration, "");
  await writeFile(target, withoutDeclaration.replace(body, `${declaration}\n${body}`));
}