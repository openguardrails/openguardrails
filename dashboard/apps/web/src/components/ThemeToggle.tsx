import { useTheme } from "../lib/theme-context";

type ThemeOption = "light" | "system" | "dark";

const OPTIONS: { value: ThemeOption; label: string; icon: JSX.Element }[] = [
  {
    value: "light",
    label: "Light",
    icon: (
      <svg className="theme-icon" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    ),
  },
  {
    value: "system",
    label: "System",
    icon: (
      <svg className="theme-icon" viewBox="0 0 24 24">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg className="theme-icon" viewBox="0 0 24 24">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    ),
  },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const index = OPTIONS.findIndex((o) => o.value === theme);

  return (
    <div className="theme-toggle">
      <div className="theme-toggle__track" style={{ "--theme-index": index } as React.CSSProperties}>
        <div className="theme-toggle__indicator" />
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={`theme-toggle__button${theme === opt.value ? " active" : ""}`}
            onClick={() => setTheme(opt.value)}
            title={opt.label}
            aria-label={`Switch to ${opt.label} theme`}
          >
            {opt.icon}
          </button>
        ))}
      </div>
    </div>
  );
}
