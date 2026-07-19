<script>
	import { focusModal } from './index.js';
	import { friendlyError } from '$lib/utils.js';
	import CloseIcon from 'virtual:icons/ri/close-line';

	/**
	 * @typedef {Object} Props
	 * @property {(value: string | null) => void} dismiss
	 */
	/** @type {Props} */
	let { dismiss } = $props();
	let error = $state('');

	/** @param {HTMLVideoElement} video */
	function scan(video) {
		let active = true;
		/** @type {MediaStream | undefined} */
		let stream;
		/** @type {number | undefined} */
		let frame;
		const start = async () => {
			try {
				if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not available in this browser.');
				if (!('BarcodeDetector' in window)) throw new Error('QR scanning is not supported here. Paste the ticket instead.');
				stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
				if (!active) return stream.getTracks().forEach((track) => track.stop());
				video.srcObject = stream;
				await video.play();
				const Detector = /** @type {new (options: { formats: string[] }) => { detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>> }} */ (window.BarcodeDetector);
				const detector = new Detector({ formats: ['qr_code'] });
				const next = async () => {
					if (!active) return;
					try {
						const value = (await detector.detect(video))[0]?.rawValue;
						if (value) return dismiss(value);
					} catch {
						// Individual frames can fail while the camera is settling.
					}
					frame = requestAnimationFrame(next);
				};
				void next();
			} catch (reason) {
				if (active) error = friendlyError(reason, 'Could not start the camera.');
			}
		};
		void start();
		return () => {
			active = false;
			if (frame) cancelAnimationFrame(frame);
			stream?.getTracks().forEach((track) => track.stop());
			video.srcObject = null;
		};
	}
</script>

<div class="fixed inset-0 z-[100] grid place-items-center bg-crust/90 p-4" role="presentation" onclick={() => dismiss(null)}>
	<div {@attach focusModal} class="w-full max-w-sm border border-surface1 bg-base shadow-float" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="qr-title" onclick={(event) => event.stopPropagation()} onkeydown={(event) => { event.stopPropagation(); if (event.key === 'Escape') dismiss(null); }}>
		<div class="flex items-center justify-between border-b border-surface0 bg-mantle px-4 py-3"><div><h2 id="qr-title" class="text-sm font-semibold">Scan server ticket</h2><p class="mt-0.5 text-[10px] text-overlay1">Point the camera at a ticket QR code</p></div><button type="button" onclick={() => dismiss(null)} class="grid size-8 place-items-center text-overlay1 hover:bg-surface0 hover:text-text"><CloseIcon class="text-[15px]"/></button></div>
		<div class="p-4"><div class="relative aspect-square overflow-hidden bg-crust"><video {@attach scan} muted playsinline class="h-full w-full object-cover"></video><div class="pointer-events-none absolute inset-8 border border-mauve/80"></div></div>{#if error}<p class="mt-3 text-xs leading-5 text-red">{error}</p>{/if}</div>
	</div>
</div>
