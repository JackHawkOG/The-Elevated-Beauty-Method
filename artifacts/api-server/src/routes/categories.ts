import { Router } from "express";
import { db, categoriesTable, coursesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { ListCategoriesResponse } from "@workspace/api-zod";

const router = Router();

router.get("/categories", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: categoriesTable.id,
      name: categoriesTable.name,
      slug: categoriesTable.slug,
      icon: categoriesTable.icon,
      description: categoriesTable.description,
      courseCount: sql<number>`(select count(*) from ${coursesTable} where ${coursesTable.categoryId} = ${categoriesTable.id})::int`,
    })
    .from(categoriesTable)
    .orderBy(categoriesTable.name);

  res.json(ListCategoriesResponse.parse(rows));
});

export default router;
