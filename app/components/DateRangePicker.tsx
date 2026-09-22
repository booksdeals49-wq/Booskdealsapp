// Shared date-range control: preset quick buttons (Last 7/30/90 days, This
// month) plus a custom range calendar, mirroring the pattern from the
// reference screenshots. Changing the range updates the URL's ?from=&to=
// params, which every report loader reads via resolveDateRange() — so this
// component itself stays free of any data-fetching concerns.
import { useState, useCallback } from "react";
import { useNavigate, useLocation } from "@remix-run/react";
import { Popover, Button, DatePicker, InlineStack, ButtonGroup, Box, Text } from "@shopify/polaris";
import { CalendarIcon } from "@shopify/polaris-icons";

const DAY_MS = 24 * 60 * 60 * 1000;

function toLabel(d: string) {
  return d;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function DateRangePicker({
  fromLabel,
  toLabel: toLabelValue,
}: {
  fromLabel: string;
  toLabel: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [popoverActive, setPopoverActive] = useState(false);

  const [{ month, year }, setMonthYear] = useState(() => {
    const d = new Date(toLabelValue + "T00:00:00.000Z");
    return { month: d.getUTCMonth(), year: d.getUTCFullYear() };
  });
  const [selectedRange, setSelectedRange] = useState({
    start: new Date(fromLabel + "T00:00:00.000Z"),
    end: new Date(toLabelValue + "T00:00:00.000Z"),
  });

  const applyRange = useCallback(
    (from: string, to: string) => {
      const params = new URLSearchParams(location.search);
      params.set("from", from);
      params.set("to", to);
      navigate(`${location.pathname}?${params.toString()}`);
      setPopoverActive(false);
    },
    [location.pathname, location.search, navigate],
  );

  const preset = (label: string, days: number) => (
    <Button
      key={label}
      pressed={
        fromLabel === fmt(new Date(Date.now() - (days - 1) * DAY_MS)) &&
        toLabelValue === fmt(new Date())
      }
      onClick={() =>
        applyRange(fmt(new Date(Date.now() - (days - 1) * DAY_MS)), fmt(new Date()))
      }
    >
      {label}
    </Button>
  );

  const thisMonth = () => {
    const now = new Date();
    const from = fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    applyRange(from, fmt(now));
  };

  return (
    <InlineStack gap="200" blockAlign="center" wrap>
      <ButtonGroup variant="segmented">
        {preset("Last 7 days", 7)}
        {preset("Last 14 days", 14)}
        {preset("Last 30 days", 30)}
        {preset("Last 60 days", 60)}
        {preset("Last 90 days", 90)}
        <Button onClick={thisMonth}>This month</Button>
      </ButtonGroup>

      <Popover
        active={popoverActive}
        activator={
          <Button icon={CalendarIcon} onClick={() => setPopoverActive((a) => !a)} disclosure>
            {`${toLabel(fromLabel)} to ${toLabel(toLabelValue)}`}
          </Button>
        }
        onClose={() => setPopoverActive(false)}
      >
        <Box padding="400">
          <InlineStack gap="200" align="start">
            <DatePicker
              month={month}
              year={year}
              selected={selectedRange}
              onMonthChange={(m, y) => setMonthYear({ month: m, year: y })}
              onChange={setSelectedRange}
              allowRange
              disableDatesAfter={new Date()}
            />
          </InlineStack>
          <Box paddingBlockStart="300">
            <InlineStack align="end" gap="200">
              <Text as="span" tone="subdued" variant="bodySm">
                {fmt(selectedRange.start)} – {fmt(selectedRange.end)}
              </Text>
              <Button
                variant="primary"
                onClick={() => applyRange(fmt(selectedRange.start), fmt(selectedRange.end))}
              >
                Apply
              </Button>
            </InlineStack>
          </Box>
        </Box>
      </Popover>
    </InlineStack>
  );
}
