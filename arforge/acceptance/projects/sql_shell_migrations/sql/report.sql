.headers off
.mode list
SELECT p.name || ':' || COUNT(w.item_id)
FROM projects AS p
LEFT JOIN work_items AS w ON w.project_id = p.project_id
GROUP BY p.project_id, p.name;
