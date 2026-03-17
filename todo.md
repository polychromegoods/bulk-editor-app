# Bulk Editor App - Bug Fix TODO

## Critical Bugs
- [x] BILL-02: Billing upgrade fix - improved returnUrl format, better error logging, moved trial marking after successful request
- [x] PROD-01/PROD-03: Pagination on Products page - added ref-based event listeners + fallback manual pagination buttons + product count indicator
- [x] Edit name now shown in History page - added bulkEditName column to PriceHistory schema and Edit Name column to table

## Important Bugs
- [x] Downgrade counter reset: cancel action now resets monthlyEdits to 0 and monthlyEditReset to current date
- [x] Large price numbers now use compact formatting (e.g., $10.0T, $1.5B, $2.3M) in History page
- [x] Products page: rebuilt with cleaner table structure and consistent column formatting

## Previously Fixed
- [x] BE-001: Loading indicator - Fixed with global overlay
- [x] BE-002: History 502 - Fixed with SQL aggregates
- [x] BE-S4-03: Net Change overflow - Fixed with compact number formatting

## New Issues
- [ ] Blank white screen on app load - app shows "Bulk Editor Pro" title but no content renders; no loading indicator visible
- [ ] Add proper loading states/skeletons so users can distinguish loading from broken
