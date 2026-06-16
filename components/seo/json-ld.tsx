import type { JsonLd as JsonLdNode } from "@/lib/seo/schema";

/**
 * Renders one or more JSON-LD blocks into the DOM.
 *
 * Pass a single schema object or an array. Arrays render as separate
 * <script> tags (cleaner for Google's Rich Results Test than a forced
 * @graph wrapper, and each block stays independently valid).
 *
 * XSS note: the payload is built from our own typed builders + static
 * content (lib/seo/*), never raw user input, and `<` is escaped so a stray
 * value can't break out of the script element.
 */
export function JsonLd({ data }: { data: JsonLdNode | JsonLdNode[] }) {
  const blocks = Array.isArray(data) ? data : [data];
  return (
    <>
      {blocks.map((block, i) => (
        <script
          key={i}
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(block).replace(/</g, "\\u003c"),
          }}
        />
      ))}
    </>
  );
}
