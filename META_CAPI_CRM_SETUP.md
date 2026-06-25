# Meta Conversions API for CRM Setup

This project sends Meta CRM lead events from the backend, not the browser. The access token must stay in backend environment variables only.

## Backend environment variables

Set these on the backend host, for example Railway or Heroku:

```env
META_CAPI_DATASET_ID=your_meta_dataset_id
META_CAPI_ACCESS_TOKEN=your_meta_access_token
META_CAPI_API_VERSION=v25.0
META_CAPI_LEAD_EVENT_SOURCE=Rozare
META_CAPI_SELLER_LEAD_EVENT_NAME=Lead
META_CAPI_STORE_VERIFICATION_EVENT_NAME=QualifiedLead
```

For Meta Test Events, temporarily add:

```env
META_CAPI_TEST_EVENT_CODE=your_test_event_code
```

Remove `META_CAPI_TEST_EVENT_CODE` after testing so production events are not marked as test traffic.

## Events sent

- `Lead`: sent when a seller account is created through either seller signup flow.
- `QualifiedLead`: sent when a seller submits a store verification application.

Each event uses Meta's CRM payload shape:

- `action_source: system_generated`
- `custom_data.event_source: crm`
- `custom_data.lead_event_source`
- hashed email and phone values in `user_data`
- `_fbc`, `_fbp`, and `fbclid` match data when available

## Testing

1. Set `META_CAPI_TEST_EVENT_CODE` from Meta Events Manager.
2. Restart the backend.
3. Complete a test seller signup or submit a store verification application.
4. Check Meta Events Manager > Test events.
5. Remove `META_CAPI_TEST_EVENT_CODE` and restart again.
