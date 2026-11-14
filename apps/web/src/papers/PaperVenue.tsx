import { useId, useState } from "react";
import type { Document, PaperMetadata } from "@neoread/core";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@neoread/ui/components/tooltip";
import { conferenceVenue } from "./conferences";
import { authorsShort, paperYear, venueLabel } from "./format";

export function PaperVenue({ metadata }: { metadata: PaperMetadata }) {
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const venue = conferenceVenue(metadata.venue || "");
  if (!venue.fullName) return <>{venueLabel(metadata)}</>;
  return (
    <Tooltip onOpenChange={setOpen}>
      <TooltipTrigger
        render={<span tabIndex={0} data-paper-venue />}
        aria-describedby={open ? tooltipId : undefined}
        className="inline-block max-w-full truncate align-bottom rounded-sm focus-visible:outline focus-visible:outline-ring"
      >
        {venue.label}
      </TooltipTrigger>
      <TooltipContent
        id={tooltipId}
        role="tooltip"
        className="block whitespace-normal break-words"
      >
        <span className="block">{venue.fullName}</span>
        {venue.original && (
          <span className="mt-1 block opacity-80">{venue.original}</span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

export function PaperByline({
  doc,
  showAuthors,
}: {
  doc: Pick<Document, "author" | "metadata">;
  showAuthors: boolean;
}) {
  const details = [showAuthors ? authorsShort(doc) : "", paperYear(doc.metadata)]
    .filter(Boolean)
    .join(" · ");
  const venue = venueLabel(doc.metadata);
  if (!details && !venue) return null;
  return (
    <p className="paper-row-byline">
      {details && <span title={details}>{details}</span>}
      {details && venue && " · "}
      {venue && <PaperVenue metadata={doc.metadata} />}
    </p>
  );
}
