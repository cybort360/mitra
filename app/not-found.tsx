import Link from "next/link";
export default function NotFound(){return <div className="empty"><div className="eyebrow">404</div><h1>Economic object not found</h1><p>The requested Mitra object is not in the local canonical dataset.</p><Link href="/overview" className="btnGhost">Return to overview</Link></div>}
