CREATE TABLE items (
    item_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title VARCHAR(200) NOT NULL CHECK(length(trim(title)) > 0),
    status VARCHAR(8) NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'closed'))
);
INSERT INTO items(title) VALUES ('arforge');
DO $$
BEGIN
    IF (SELECT COUNT(*) FROM items) <> 1 THEN
        RAISE EXCEPTION 'integration mismatch';
    END IF;
END
$$;
