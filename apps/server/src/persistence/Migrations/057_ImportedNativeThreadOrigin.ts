import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Early V2 imports saved the native identity without its origin. The import
// event proves it already existed; a native ID alone can also be preallocated
// for a new session. Repair the log as well as the projection so replay keeps
// this distinction, including updates written after the initial import.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const importedIdentities = sql`
    SELECT
      json_extract(payload_json, '$.id'),
      json_extract(payload_json, '$.providerInstanceId'),
      json_extract(payload_json, '$.nativeThreadRef.nativeId')
    FROM orchestration_events
    WHERE application_event_version = 2
      AND event_type = 'provider-thread.updated'
      AND event_id GLOB 'agent-session-import:v2:provider-thread:*'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.nativeThreadOrigin', 'imported')
    WHERE application_event_version = 2
      AND event_type = 'provider-thread.updated'
      AND json_extract(payload_json, '$.nativeThreadOrigin') IS NULL
      AND (
        json_extract(payload_json, '$.id'),
        json_extract(payload_json, '$.providerInstanceId'),
        json_extract(payload_json, '$.nativeThreadRef.nativeId')
      ) IN (${importedIdentities})
  `;
  yield* sql`
    UPDATE orchestration_v2_projection_provider_threads
    SET payload_json = json_set(payload_json, '$.nativeThreadOrigin', 'imported')
    WHERE json_extract(payload_json, '$.nativeThreadOrigin') IS NULL
      AND (
        provider_thread_id,
        provider_instance_id,
        json_extract(payload_json, '$.nativeThreadRef.nativeId')
      ) IN (${importedIdentities})
  `;
});
