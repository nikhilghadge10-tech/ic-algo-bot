# TradingView Webhook Payloads

Use these payloads when creating TradingView alerts for the algo bot.

The bot accepts only the configured underlying symbol (`UNDERLYING_SYMBOL`,
default `NIFTY`; supported values: `NIFTY`, `BANKNIFTY`). Keep `symbol` as
`{{ticker}}` so alerts from other charts can be ignored safely by the webhook
guard.

## LONG_ENTRY

```json
{
  "signal": "LONG_ENTRY",
  "symbol": "{{ticker}}",
  "price": "{{close}}",
  "time": "{{time}}",
  "interval": "{{interval}}"
}
```

## SHORT_ENTRY

```json
{
  "signal": "SHORT_ENTRY",
  "symbol": "{{ticker}}",
  "price": "{{close}}",
  "time": "{{time}}",
  "interval": "{{interval}}"
}
```

## LONG_EXIT

```json
{
  "signal": "LONG_EXIT",
  "symbol": "{{ticker}}",
  "price": "{{close}}",
  "time": "{{time}}",
  "interval": "{{interval}}"
}
```

## SHORT_EXIT

```json
{
  "signal": "SHORT_EXIT",
  "symbol": "{{ticker}}",
  "price": "{{close}}",
  "time": "{{time}}",
  "interval": "{{interval}}"
}
```
