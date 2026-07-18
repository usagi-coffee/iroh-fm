<script>
	let { name, size = 20, stroke = 1.8, label = '' } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={stroke}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden={label ? undefined : 'true'}
	aria-label={label || undefined}
>
	{#if name === 'home'}
		<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 21v-8h6v8"/>
	{:else if name === 'library'}
		<path d="M4 19.5V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1 0-4h12"/><path d="M8 7h6"/>
	{:else if name === 'heart'}
		<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>
	{:else if name === 'search'}
		<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>
	{:else if name === 'play'}
		<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>
	{:else if name === 'pause'}
		<path d="M8 5v14M16 5v14" stroke-width="3"/>
	{:else if name === 'next'}
		<path d="m6 5 10 7L6 19ZM19 5v14"/>
	{:else if name === 'previous'}
		<path d="m18 5-10 7 10 7ZM5 5v14"/>
	{:else if name === 'shuffle'}
		<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>
	{:else if name === 'repeat'}
		<path d="m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/>
	{:else if name === 'volume'}
		<path d="M11 5 6 9H2v6h4l5 4ZM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>
	{:else if name === 'more'}
		<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>
	{:else if name === 'chevron'}
		<path d="m9 18 6-6-6-6"/>
	{:else if name === 'disc'}
		<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 3v7"/>
	{:else if name === 'disconnect'}
		<path d="M9 12h12M17 8l4 4-4 4M13 5V3H4v18h9v-2"/>
	{:else if name === 'music'}
		<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>
	{:else if name === 'arrow'}
		<path d="M5 12h14M13 6l6 6-6 6"/>
	{:else if name === 'close'}
		<path d="m6 6 12 12M18 6 6 18"/>
	{:else if name === 'settings'}
		<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>
	{:else if name === 'qr'}
		<path d="M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h3v3h-3ZM18 18h3v3h-3ZM18 14h3M14 19v2"/>
	{:else if name === 'copy'}
		<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>
	{:else if name === 'refresh'}
		<path d="M20 7v5h-5M4 17v-5h5M6.1 9a7 7 0 0 1 11.4-2.5L20 9M4 15l2.5 2.5A7 7 0 0 0 17.9 15"/>
	{/if}
</svg>
