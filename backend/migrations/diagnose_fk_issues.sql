-- Diagnostic script to find all foreign key constraints referencing 'users' table
-- Run this to identify any remaining migration issues

-- Find all foreign keys referencing 'users' table
SELECT 
    tc.table_name, 
    kcu.column_name,
    tc.constraint_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
FROM 
    information_schema.table_constraints AS tc 
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
WHERE 
    tc.constraint_type = 'FOREIGN KEY' 
    AND ccu.table_name = 'users'
ORDER BY 
    tc.table_name;

-- Also check if 'users' table still exists
SELECT 
    CASE 
        WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') 
        THEN 'WARNING: users table still exists!'
        ELSE 'OK: users table has been removed'
    END AS status;

