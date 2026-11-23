// Leaf module: the bridge id derived from the registration, used by the ghost registry,
// network branding, index.ts and the importer without importing each other.
/**
 * Bridge name from the registration's bot localpart: `bbctl register <name>` makes the bot
 * `<name>bot` and the ghost namespace `@<name>_.+`, so a second bridge (`sh-zalo2`) differs.
 */
export const bridgeIdFor = (senderLocalpart?: string): string => (senderLocalpart ?? 'sh-zalobot').replace(/bot$/, '');
