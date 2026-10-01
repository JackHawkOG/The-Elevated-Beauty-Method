-- Read-only. Set search_path to exactly the reviewed enrollment schema first.
SELECT current_database() AS database_name, current_schema() AS schema_name,
       'enrollments'::regclass AS enrollment_table;

SELECT i.oid AS index_oid, x.indrelid::regclass AS indexed_table,
       pg_get_indexdef(i.oid) AS definition,
       x.indisunique, x.indisvalid, x.indisready, x.indimmediate,
       pg_get_expr(x.indpred, x.indrelid) AS predicate
FROM pg_class i JOIN pg_index x ON x.indexrelid = i.oid
WHERE i.oid = to_regclass('enrollments_user_id_course_id_unique');

-- Owning constraints AND foreign keys using this index.
SELECT con.oid AS constraint_oid, con.conrelid::regclass AS table_name,
       con.conname, con.contype, con.conindid AS index_oid,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
WHERE con.conindid = to_regclass('enrollments_user_id_course_id_unique')
ORDER BY con.oid;

-- Dependencies in both directions (ownership may point FROM the index).
SELECT d.deptype,
       pg_describe_object(d.classid, d.objid, d.objsubid) AS dependent,
       pg_describe_object(d.refclassid, d.refobjid, d.refobjsubid) AS referenced
FROM pg_depend d
WHERE (d.classid = 'pg_class'::regclass
       AND d.objid = to_regclass('enrollments_user_id_course_id_unique'))
   OR (d.refclassid = 'pg_class'::regclass
       AND d.refobjid = to_regclass('enrollments_user_id_course_id_unique'));

-- Review all inbound FKs before deleting duplicate enrollment identities.
SELECT con.conrelid::regclass AS referencing_table, con.conname,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
WHERE con.contype = 'f' AND con.confrelid = 'enrollments'::regclass;

SELECT user_id, course_id, count(*) AS copies, min(id) AS smallest_id
FROM enrollments GROUP BY user_id, course_id HAVING count(*) > 1;