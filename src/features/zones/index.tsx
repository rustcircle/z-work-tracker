export function ActiveZoneBar() {
  return null;
}

export interface ZonePickerProps {
  open: boolean;
  title: string;
  value: string | null;
  onPick: (zone: string) => void;
  onClose: () => void;
}

export function ZonePickerDialog(_props: ZonePickerProps) {
  return null;
}
