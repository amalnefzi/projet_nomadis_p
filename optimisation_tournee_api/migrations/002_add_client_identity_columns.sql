ALTER TABLE client_visits
    ADD COLUMN client_id BIGINT UNSIGNED NULL AFTER id,
    ADD INDEX idx_client_visits_client_id_date (client_id, check_in_at);

ALTER TABLE ia_prediction_items
    ADD COLUMN client_id BIGINT UNSIGNED NULL AFTER run_code,
    ADD INDEX ia_prediction_items_client_id_idx (client_id);

ALTER TABLE ia_prediction_feedback
    ADD COLUMN client_id BIGINT UNSIGNED NULL AFTER run_code,
    ADD INDEX ia_prediction_feedback_client_id_idx (client_id);

ALTER TABLE tournees
    ADD COLUMN client_id BIGINT UNSIGNED NULL AFTER code_jour,
    ADD INDEX tournees_client_id_idx (client_id);
