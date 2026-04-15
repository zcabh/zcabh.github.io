# Repo Notes For Codex

## UI Text Stack Guardrail

Text can look overlapped even when layout is technically correct if primary and secondary lines use the same rhythm, size, or line-height.

### Cause
- Shared utility classes are often too generic for dense card content.
- On narrow screens, long labels and wrapped text make weak hierarchy look like collision.

### Guidance
- For dense cards, use card-specific text stack styles for spacing and hierarchy.
- Give secondary text its own style instead of relying only on a generic muted class.
- Always check wrapped text on mobile widths and ensure text blocks have safe wrapping rules.

### Quick Check
- Review title/meta and amount/secondary-amount pairs separately.
- Test short labels, long Korean labels, and long unbroken strings on small screens.
- If text feels visually attached, fix local spacing and line-height before changing the overall layout.
