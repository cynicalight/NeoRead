import type { Run } from "./protocol";

/** Formatted citation text as it will appear in the document. */
export function RunsText({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((run, i) => {
        let node: React.ReactNode = run.text;
        if (run.sup) node = <sup>{node}</sup>;
        if (run.sub) node = <sub>{node}</sub>;
        return (
          <span
            key={i}
            className={[
              run.i && "italic",
              run.b && "font-semibold",
              run.u && "underline",
              run.sc && "[font-variant:small-caps]",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            {node}
          </span>
        );
      })}
    </>
  );
}
