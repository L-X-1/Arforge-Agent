CREATE DATABASE acceptance;
CREATE TABLE acceptance.items (
    item_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    title VARCHAR(200) NOT NULL,
    status VARCHAR(8) NOT NULL DEFAULT 'open',
    CHECK (CHAR_LENGTH(TRIM(title)) > 0),
    CHECK (status IN ('open', 'closed'))
);
INSERT INTO acceptance.items(title) VALUES ('arforge');
SELECT IF(COUNT(*) = 1, 'PASS', 'FAIL') FROM acceptance.items;
