<script lang="ts">
	import { onMount } from 'svelte';

	const dateFormatter = new Intl.DateTimeFormat('fr-FR', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: 'Europe/Paris'
	});

	const timeFormatter = new Intl.DateTimeFormat('fr-FR', {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
		timeZone: 'Europe/Paris'
	});

	let currentDateTime = '';

	function refreshDateTime() {
		const now = new Date();
		currentDateTime = `${dateFormatter.format(now)} ${timeFormatter.format(now)}`;
	}

	refreshDateTime();

	onMount(() => {
		const timer = window.setInterval(refreshDateTime, 1000);

		return () => window.clearInterval(timer);
	});
</script>

<svelte:head>
	<title>Core Front</title>
	<meta name="description" content="Base SPA du front EERP" />
</svelte:head>

<section class="shell">
	<p class="timestamp" aria-label="Date et heure actuelles a Paris">{currentDateTime}</p>
</section>

<style>
	.shell {
		position: relative;
		min-height: 100vh;
		overflow: hidden;
	}

	.shell::before,
	.shell::after {
		content: '';
		position: absolute;
		border-radius: 50%;
		filter: blur(18px);
		opacity: 0.8;
	}

	.shell::before {
		top: -12rem;
		left: -8rem;
		width: 24rem;
		height: 24rem;
		background: rgba(255, 243, 214, 0.2);
	}

	.shell::after {
		right: -6rem;
		bottom: -8rem;
		width: 20rem;
		height: 20rem;
		background: rgba(173, 225, 235, 0.24);
	}

	.timestamp {
		position: absolute;
		top: 0;
		right: 0;
		z-index: 1;
		margin: 0;
		padding: 0.5rem 0.8rem;
		border: 1px solid rgba(255, 255, 255, 0.32);
		border-radius: 0 0 0 10px;
		background: rgba(8, 24, 37, 0.24);
		box-shadow: 0 12px 28px rgba(2, 10, 18, 0.18);
		backdrop-filter: blur(18px);
		-webkit-backdrop-filter: blur(18px);
		font-size: clamp(0.82rem, 0.4rem + 0.65vw, 0.96rem);
		font-weight: 600;
		letter-spacing: 0.03em;
		font-variant-numeric: tabular-nums;
		color: var(--color-text-strong);
	}

	@media (max-width: 640px) {
		.timestamp {
			top: 0;
			right: 0;
			padding: 0.45rem 0.7rem;
			font-size: 0.8rem;
		}
	}
</style>
