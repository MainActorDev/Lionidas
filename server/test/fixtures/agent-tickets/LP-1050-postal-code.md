# LP-1050 — Address form rejects postal codes with spaces

- Type: Bug
- App: com.lionparcel.consumer
- Screens: address-form
- Priority: P2

## Requirement

The address form's postal-code field rejects codes containing spaces (e.g. `12 345`), which are valid in several regions. The field should accept them.

## Context

- The form is screen `address-form`, field identifier `postal_code_field`.
- Validation errors surface through the field's `error` state.

## Acceptance

- Given the address form, when I type a postal code with a space, then the form accepts it.
- Given the address form, when I type a postal code with letters only, then the field shows its `error` state.
