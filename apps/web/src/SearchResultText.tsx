export function SearchResultText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const pattern = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return (
    <>
      {text
        .split(new RegExp(`(${pattern})`, "giu"))
        .map((part, index) =>
          index % 2 ? <strong key={index}>{part}</strong> : part,
        )}
    </>
  );
}
