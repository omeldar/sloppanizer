import { Link } from "@tanstack/react-router";
import {
  createContext,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { heatStep, niceScale } from "./stats.ts";
import styles from "./Stats.module.css";

/**
 * Small charts for the Statistics page, drawn by hand (the app ships no chart library or CDN). They
 * follow one set of rules: one color per series from the validated slots (--viz-1 blue, --viz-2
 * orange), a single-hue ramp for magnitude, thin marks with 4px rounded data ends, hairline grids, a
 * legend for two series, a tooltip on hover and focus, and a table view with every number.
 */

// ---------- tooltip ----------

export interface TipRow {
  label: string;
  value: string;
  /** A short key of the series color ("line" for lines, "bar" for bars and cells). */
  key?: { kind: "line" | "bar"; color: string };
}
export interface Tip {
  title: string;
  rows: TipRow[];
}

interface TipState extends Tip {
  x: number;
  y: number;
  /** The card's width when shown, so the tip stays inside it. */
  width: number;
}

const TipContext = createContext<{
  show: (at: { clientX: number; clientY: number }, tip: Tip) => void;
  hide: () => void;
} | null>(null);

/** Tooltip handlers for a mark: pointer and keyboard focus show the same details. */
export function useTip() {
  const context = useContext(TipContext);
  return (tip: Tip) => ({
    onPointerMove: (event: PointerEvent<Element>) => context?.show(event, tip),
    onPointerLeave: () => context?.hide(),
    onFocus: (event: FocusEvent<Element>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      context?.show({ clientX: rect.left + rect.width / 2, clientY: rect.top }, tip);
    },
    onBlur: () => context?.hide(),
  });
}

/** The width of an element, followed as it changes (charts draw to the space they have). */
export function useWidth<T extends HTMLElement>(fallback = 600) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width: width || fallback };
}

// ---------- card ----------

export interface ChartTable {
  head: string[];
  rows: (string | number)[][];
}

/**
 * A chart with its title, an optional legend, a tooltip layer and a table view of the same numbers
 * (tooltips enhance, the table makes every value reachable without them).
 */
export function ChartCard({
  title,
  subtitle,
  legend,
  table,
  wide = false,
  children,
}: {
  title: string;
  subtitle?: string;
  legend?: { label: string; color: string; kind: "bar" | "line" }[];
  table: ChartTable;
  wide?: boolean;
  children: ReactNode;
}) {
  const card = useRef<HTMLElement>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const [asTable, setAsTable] = useState(false);
  const show = useCallback((at: { clientX: number; clientY: number }, next: Tip) => {
    const rect = card.current?.getBoundingClientRect();
    if (!rect) return;
    setTip({ ...next, x: at.clientX - rect.left, y: at.clientY - rect.top, width: rect.width });
  }, []);
  const tips = useMemo(() => ({ show, hide: () => setTip(null) }), [show]);
  return (
    <section ref={card} className={styles.card} data-wide={wide || undefined} aria-label={title}>
      <header className={styles.cardHead}>
        <div>
          <h2 className={styles.cardTitle}>{title}</h2>
          {subtitle && <p className={styles.cardSub}>{subtitle}</p>}
        </div>
        <button
          type="button"
          className={styles.tableToggle}
          aria-pressed={asTable}
          onClick={() => setAsTable(!asTable)}
        >
          {asTable ? "Chart" : "Table"}
        </button>
      </header>
      {legend && legend.length > 1 && !asTable && (
        <ul className={styles.legend} aria-label="Legend">
          {legend.map((item) => (
            <li key={item.label}>
              <span
                className={styles.legendKey}
                data-kind={item.kind}
                style={{ "--key": item.color } as CSSProperties}
              />
              {item.label}
            </li>
          ))}
        </ul>
      )}
      {asTable ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {table.head.map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={String(row[0])}>
                  {row.map((cell, i) => (
                    // oxlint-disable-next-line react/no-array-index-key -- columns are fixed per table
                    <td key={i}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <TipContext.Provider value={tips}>{children}</TipContext.Provider>
      )}
      {tip && !asTable && (
        <div
          className={styles.tip}
          role="status"
          style={{
            left: Math.max(8, Math.min(tip.x + 12, tip.width - 200)),
            top: Math.max(8, tip.y - 12),
          }}
        >
          <div className={styles.tipTitle}>{tip.title}</div>
          {tip.rows.map((row) => (
            <div key={row.label} className={styles.tipRow}>
              {row.key && (
                <span
                  className={styles.tipKey}
                  data-kind={row.key.kind}
                  style={{ "--key": row.key.color } as CSSProperties}
                />
              )}
              <strong>{row.value}</strong>
              <span className={styles.tipLabel}>{row.label}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- marks ----------

/** A column from the baseline up with a 4px rounded top, square at the baseline. */
function columnPath(x: number, w: number, top: number, base: number): string {
  const h = base - top;
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}

const AXIS_W = 40;
const BOTTOM = 22;

/** Y axis ticks and hairline gridlines. */
function Grid({
  ticks,
  y,
  width,
  format,
}: {
  ticks: number[];
  y: (v: number) => number;
  width: number;
  format: (v: number) => string;
}) {
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={AXIS_W}
            x2={width}
            y1={y(t)}
            y2={y(t)}
            className={t === 0 ? styles.baseline : styles.gridline}
          />
          <text x={AXIS_W - 6} y={y(t)} dy="0.32em" textAnchor="end" className={styles.axisText}>
            {format(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Which of `count` x labels to print so they do not collide (every nth). */
const labelEvery = (count: number, width: number, labelPx = 44): number =>
  Math.max(1, Math.ceil((count * labelPx) / Math.max(1, width)));

// ---------- horizontal bars ----------

export interface BarRow {
  key: string;
  label: string;
  /** The entity's own swatch beside the name (a project color); identity, not data. */
  swatch?: string;
  to?: { to: "/projects/$slug"; params: { slug: string } } | { to: "/people/$id"; params: { id: string } };
  value: number;
  /** Printed at the bar's tip. */
  text: string;
  tip: Tip;
}

/** Ranked horizontal bars, one color, each named and valued in text; a row links to its page. */
export function BarList({ rows, empty }: { rows: BarRow[]; empty: string }) {
  const tip = useTip();
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className={styles.empty}>{empty}</p>;
  return (
    <ul className={styles.bars}>
      {rows.map((row) => {
        const name = (
          <>
            {row.swatch && (
              <span className={styles.swatch} style={{ "--swatch": row.swatch } as CSSProperties} />
            )}
            <span className={styles.barName}>{row.label}</span>
          </>
        );
        return (
          <li key={row.key} className={styles.barRow} {...tip(row.tip)}>
            {row.to ? (
              <Link {...row.to} className={styles.barLabel}>
                {name}
              </Link>
            ) : (
              <span className={styles.barLabel}>{name}</span>
            )}
            <span className={styles.barTrack}>
              <span className={styles.barRoom}>
                <span
                  className={styles.bar}
                  style={{
                    width: `${max > 0 ? Math.max(row.value > 0 ? 1 : 0, (row.value / max) * 100) : 0}%`,
                  }}
                />
              </span>
              <span className={styles.barValue}>{row.text}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------- grouped columns ----------

export interface ColumnGroup {
  key: string;
  label: string;
  values: number[];
  tip: Tip;
}

/** Columns per x (a week), one per series side by side, with a 2px gap; the whole slot is the hit target. */
export function GroupedColumns({
  groups,
  colors,
  format,
  height = 200,
}: {
  groups: ColumnGroup[];
  colors: string[];
  format: (v: number) => string;
  height?: number;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const tip = useTip();
  const max = Math.max(0, ...groups.flatMap((g) => g.values));
  const { top, ticks } = niceScale(max);
  const base = height - BOTTOM;
  const y = (v: number) => base - (v / top) * (base - 8);
  const slot = (width - AXIS_W) / Math.max(1, groups.length);
  const series = colors.length;
  const bar = Math.min(24, Math.max(3, (slot * 0.7 - 2 * (series - 1)) / series));
  const every = labelEvery(groups.length, width - AXIS_W);
  return (
    <div ref={ref} className={styles.plot}>
      <svg width={width} height={height} role="img" aria-label="Columns per week">
        <Grid ticks={ticks} y={y} width={width} format={format} />
        {groups.map((g, i) => {
          const x0 = AXIS_W + i * slot + (slot - (bar * series + 2 * (series - 1))) / 2;
          return (
            <g key={g.key}>
              {g.values.map((v, s) => (
                <path
                  // oxlint-disable-next-line react/no-array-index-key -- series order is fixed
                  key={s}
                  d={columnPath(x0 + s * (bar + 2), bar, y(v), base)}
                  fill={colors[s]}
                  className={styles.mark}
                />
              ))}
              {i % every === 0 && (
                <text
                  x={AXIS_W + i * slot + slot / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className={styles.axisText}
                >
                  {g.label}
                </text>
              )}
              <rect
                x={AXIS_W + i * slot}
                y={0}
                width={slot}
                height={base}
                className={styles.hit}
                tabIndex={0}
                aria-label={`${g.tip.title}: ${g.tip.rows.map((r) => `${r.label} ${r.value}`).join(", ")}`}
                {...tip(g.tip)}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------- lines ----------

/** Two or more lines over the same x, with a crosshair that snaps to the nearest x and end labels. */
export function Lines({
  labels,
  series,
  height = 200,
  tipTitle,
}: {
  labels: string[];
  series: { name: string; color: string; values: number[] }[];
  height?: number;
  tipTitle: (index: number) => string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number | null>(null);
  const context = useContext(TipContext);
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const { top, ticks } = niceScale(max);
  const right = 36;
  const base = height - BOTTOM;
  const y = (v: number) => base - (v / top) * (base - 8);
  const n = labels.length;
  const x = (i: number) => AXIS_W + 8 + (n <= 1 ? 0 : (i / (n - 1)) * (width - AXIS_W - 16 - right));
  const every = labelEvery(n, width - AXIS_W);
  const showAt = (index: number, clientX: number, clientY: number) => {
    setAt(index);
    context?.show(
      { clientX, clientY },
      {
        title: tipTitle(index),
        rows: series.map((s) => ({
          label: s.name,
          value: String(s.values[index] ?? 0),
          key: { kind: "line", color: s.color },
        })),
      },
    );
  };
  return (
    <div ref={ref} className={styles.plot}>
      <svg width={width} height={height} role="img" aria-label={series.map((s) => s.name).join(" and ")}>
        <Grid ticks={ticks} y={y} width={width - right} format={(v) => String(v)} />
        {labels.map(
          (label, i) =>
            i % every === 0 && (
              <text key={label} x={x(i)} y={height - 6} textAnchor="middle" className={styles.axisText}>
                {label}
              </text>
            ),
        )}
        {at !== null && <line x1={x(at)} x2={x(at)} y1={4} y2={base} className={styles.crosshair} />}
        {series.map((s) => (
          <g key={s.name}>
            <polyline
              points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {n > 0 && (
              <>
                <circle
                  cx={x(n - 1)}
                  cy={y(s.values[n - 1] ?? 0)}
                  r={4}
                  fill={s.color}
                  className={styles.dot}
                />
                <text x={x(n - 1) + 8} y={y(s.values[n - 1] ?? 0)} dy="0.32em" className={styles.endLabel}>
                  {s.values[n - 1] ?? 0}
                </text>
              </>
            )}
            {at !== null && (
              <circle cx={x(at)} cy={y(s.values[at] ?? 0)} r={4} fill={s.color} className={styles.dot} />
            )}
          </g>
        ))}
        <rect
          x={AXIS_W}
          y={0}
          width={Math.max(0, width - AXIS_W)}
          height={base}
          className={styles.hit}
          onPointerMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - box.left - 8) / Math.max(1, box.width - 16 - right);
            showAt(Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1)))), event.clientX, event.clientY);
          }}
          onPointerLeave={() => {
            setAt(null);
            context?.hide();
          }}
        />
      </svg>
    </div>
  );
}

// ---------- heatmaps ----------

export interface HeatCell {
  key: string;
  row: number;
  col: number;
  value: number;
  tip: Tip;
  /** Outside the period: drawn as nothing at all. */
  blank?: boolean;
}

/** A grid of cells on a five-step single-hue scale, with a "less … more" key. */
export function Heatmap({
  cells,
  rows,
  cols,
  rowLabels,
  colLabels,
  cell = 18,
  label,
}: {
  cells: HeatCell[];
  rows: number;
  cols: number;
  rowLabels: string[];
  colLabels: { col: number; text: string }[];
  cell?: number;
  label: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const tip = useTip();
  const left = 34;
  const size = Math.max(11, Math.min(cell, Math.floor((width - left) / cols) - 2));
  const max = Math.max(0, ...cells.map((c) => c.value));
  const height = rows * (size + 2) + 18;
  // Column labels at least 48px apart, so they never run into each other.
  const minGap = Math.ceil(48 / (size + 2));
  const shownLabels: typeof colLabels = [];
  for (const candidate of colLabels) {
    const last = shownLabels.at(-1);
    if (!last || candidate.col - last.col >= minGap) shownLabels.push(candidate);
  }
  return (
    <div ref={ref} className={styles.plot}>
      <svg width={left + cols * (size + 2)} height={height} role="img" aria-label={label}>
        {rowLabels.map((text, r) => (
          <text
            key={text}
            x={left - 6}
            y={r * (size + 2) + size / 2}
            dy="0.32em"
            textAnchor="end"
            className={styles.axisText}
          >
            {text}
          </text>
        ))}
        {shownLabels.map((c) => (
          <text key={c.col} x={left + c.col * (size + 2)} y={height - 4} className={styles.axisText}>
            {c.text}
          </text>
        ))}
        {cells.map((c) =>
          c.blank ? null : (
            <rect
              key={c.key}
              x={left + c.col * (size + 2)}
              y={c.row * (size + 2)}
              width={size}
              height={size}
              rx={3}
              className={styles.cell}
              data-step={heatStep(c.value, max)}
              {...tip(c.tip)}
            />
          ),
        )}
      </svg>
      <div className={styles.scale} aria-hidden="true">
        <span>Less</span>
        {[0, 1, 2, 3, 4, 5].map((step) => (
          <span key={step} className={styles.scaleCell} data-step={step} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}

/** Columns of one series with the value on each cap (few, ordered categories). */
export function Columns({
  items,
  color,
  height = 180,
}: {
  items: { key: string; label: string; value: number; tip: Tip }[];
  color: string;
  height?: number;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const tip = useTip();
  const max = Math.max(0, ...items.map((i) => i.value));
  const { top } = niceScale(max);
  const base = height - BOTTOM;
  const y = (v: number) => base - (v / top) * (base - 22);
  const slot = width / Math.max(1, items.length);
  const bar = Math.min(24, slot * 0.6);
  return (
    <div ref={ref} className={styles.plot}>
      <svg width={width} height={height} role="img" aria-label="Columns">
        <line x1={0} x2={width} y1={base} y2={base} className={styles.baseline} />
        {items.map((item, i) => {
          const cx = i * slot + slot / 2;
          return (
            <g key={item.key}>
              <path
                d={columnPath(cx - bar / 2, bar, y(item.value), base)}
                fill={color}
                className={styles.mark}
              />
              <text x={cx} y={y(item.value) - 6} textAnchor="middle" className={styles.capLabel}>
                {item.value}
              </text>
              <text x={cx} y={height - 6} textAnchor="middle" className={styles.axisText}>
                {item.label}
              </text>
              <rect x={i * slot} y={0} width={slot} height={base} className={styles.hit} {...tip(item.tip)} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
