WHENEVER SQLERROR EXIT SQL.SQLCODE
CREATE TABLE acceptance_items (
    item_id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title VARCHAR2(200) NOT NULL,
    status VARCHAR2(8) DEFAULT 'open' NOT NULL
        CHECK(status IN ('open', 'closed'))
);
INSERT INTO acceptance_items(title) VALUES ('arforge');
COMMIT;
DECLARE
    observed NUMBER;
    rejected BOOLEAN := FALSE;
BEGIN
    SELECT COUNT(*) INTO observed FROM acceptance_items;
    IF observed <> 1 THEN
        RAISE_APPLICATION_ERROR(-20001, 'integration mismatch');
    END IF;
    BEGIN
        INSERT INTO acceptance_items(title, status) VALUES ('bad', 'deleted');
    EXCEPTION
        WHEN OTHERS THEN rejected := TRUE;
    END;
    IF NOT rejected THEN
        RAISE_APPLICATION_ERROR(-20002, 'constraint was bypassed');
    END IF;
END;
/
EXIT 0
