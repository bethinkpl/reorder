# `@bethinkpl/reorder`
Customized fork of [@reorder/reorderjs](https://github.com/reorder-js/reorder).
## Changes
### New features
- added day granularity for frequency intervals
### Improvements / Fixes
- prevents executing `POST /store/carts/{cartId}/complete` for carts containing subscription items
- behaviour of `POST /store/carts/{cartId}/subscribe` matches it's non-subscription counterpart more closely (dropped `subscription` field, supports query params and uses same defaults)
- shipping address is optional when item(s) in subscription cart don't require shipping (i.e.: `item.requires_shipping = false`)
### QoL
- addition of eslint lint rules
- improved test setup

#
*Content of README.md WIP*