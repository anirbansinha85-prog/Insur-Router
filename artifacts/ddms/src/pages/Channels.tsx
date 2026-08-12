import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  useListChannels,
  useConnectChannel,
  useSetChannelActive,
  useDisconnectChannel,
  type ChannelStatus,
} from "@workspace/api-client-react"
import {
  AlertTriangle,
  Check,
  Loader2,
  Mail,
  MessageCircle,
  Power,
  Trash2,
} from "lucide-react"

/**
 * The dealership's own messaging accounts (OBJ-27, R-106).
 *
 * ## What this screen is really deciding
 *
 * Not a settings form. Connecting a WhatsApp number is the moment this product
 * stops drafting and starts speaking to a dealership's customers from a number
 * those customers recognise as theirs. Everything about the page is arranged
 * around making that moment deliberate rather than incidental.
 *
 * Hence: a channel arrives **switched off** however many times a token is
 * pasted, the switch is a separate act from the saving, and the copy says what
 * turning it on means rather than saying "enabled".
 *
 * ## No secret is ever on this page
 *
 * The token field is write-only. What comes back is four masked characters —
 * enough to tell two tokens apart, useless to anybody who only has this — and
 * the API has no shape that could return more, because the decrypting function
 * is private to one server module. That is a property of the type rather than
 * a rule each screen has to remember.
 *
 * ## The blocker sentence comes from the server
 *
 * Four reasons a channel cannot be used and three of them are the dealership's
 * own. The server words each separately and this renders it, because *no
 * transport is configured* — one sentence for all four — read as a gap in the
 * product and sent people to ask us about something they could fix themselves.
 */

const META: Record<
  string,
  { title: string; icon: typeof Mail; addressLabel: string; secretLabel: string; blurb: string }
> = {
  WHATSAPP: {
    title: "WhatsApp",
    icon: MessageCircle,
    addressLabel: "WhatsApp Business number",
    secretLabel: "Permanent access token",
    blurb:
      "Messages go out from the dealership's own number, on the dealership's own Meta account. DDMS holds no number of its own, so what a customer sees is the number they already have saved.",
  },
  EMAIL: {
    title: "Email",
    icon: Mail,
    addressLabel: "Send from",
    secretLabel: "Mailbox password",
    blurb:
      "Used for the one thing that goes out without a person approving it: telling a member of staff about work assigned to them. Every customer message needs somebody's name on it whatever is connected here.",
  },
}

function ChannelCard({ status }: { status: ChannelStatus }) {
  const qc = useQueryClient()
  const meta = META[status.channel] ?? META.EMAIL!
  const Icon = meta.icon

  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState(status.displayAddress ?? "")
  const [secret, setSecret] = useState("")
  const [signing, setSigning] = useState("")
  const [phoneNumberId, setPhoneNumberId] = useState("")
  const [host, setHost] = useState("")
  const [port, setPort] = useState("587")
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["/api/dms/channels"] })
  const onError = (e: unknown) =>
    setError(
      (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        "That did not work.",
    )

  const connect = useConnectChannel()
  const activate = useSetChannelActive()
  const disconnect = useDisconnectChannel()

  const save = () => {
    setError(null)
    connect.mutate(
      {
        data: {
          channel: status.channel as "WHATSAPP" | "EMAIL",
          displayAddress: address,
          secret,
          signingSecret: signing || null,
          config:
            status.channel === "WHATSAPP"
              ? { phoneNumberId }
              : { host, port: Number(port), secure: Number(port) === 465, user: address },
        },
      },
      {
        onSuccess: () => {
          setSecret("")
          setSigning("")
          setOpen(false)
          invalidate()
        },
        onError,
      },
    )
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="flex items-start justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-bold text-slate-900">{meta.title}</h2>
            {status.active ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                <Check className="w-3 h-3" /> Live
              </span>
            ) : status.configured ? (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                Connected, off
              </span>
            ) : (
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5">
                Not connected
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl leading-snug">{meta.blurb}</p>

          {status.configured && (
            <dl className="mt-2 text-xs text-slate-600 space-y-0.5">
              <div>
                <span className="text-slate-400">Sends from</span>{" "}
                <span className="font-medium tabular-nums">{status.displayAddress}</span>
              </div>
              <div>
                <span className="text-slate-400">Token</span>{" "}
                <span className="font-mono">{status.secretHint}</span>
              </div>
              {status.channel === "WHATSAPP" && (
                <div className={status.canReceive ? "text-slate-600" : "text-amber-700"}>
                  {status.canReceive
                    ? "Replies come back in — the webhook is signed and verified."
                    : "No app secret saved, so replies cannot be received. An unsigned webhook is an open door and is refused rather than trusted."}
                </div>
              )}
              {status.lastUsedAt && (
                <div>
                  <span className="text-slate-400">Last used</span>{" "}
                  {new Date(status.lastUsedAt).toLocaleString("en-IN")}
                </div>
              )}
              {status.lastError && (
                <div className="text-rose-700 max-w-xl">{status.lastError}</div>
              )}
            </dl>
          )}

          {status.blocker && (
            <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 max-w-2xl leading-snug">
              {status.blocker}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {status.configured && (
            <button
              onClick={() =>
                activate.mutate(
                  { data: { channel: status.channel as unknown as "WHATSAPP" | "EMAIL", active: !status.active } },
                  { onSuccess: invalidate, onError },
                )
              }
              disabled={activate.isPending}
              className={`inline-flex items-center gap-1.5 text-xs font-semibold h-8 px-3 rounded-md disabled:opacity-50 ${
                status.active
                  ? "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  : "bg-slate-900 text-white hover:bg-slate-800"
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              {status.active ? "Switch off" : "Switch on"}
            </button>
          )}
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-xs font-medium h-8 px-3 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          >
            {status.configured ? "Replace" : "Connect"}
          </button>
          {status.configured && (
            <button
              onClick={() => {
                if (!window.confirm(`Disconnect ${meta.title}? The stored credential is deleted.`))
                  return
                disconnect.mutate(
                  { channel: status.channel as unknown as "WHATSAPP" | "EMAIL" },
                  { onSuccess: invalidate, onError },
                )
              }}
              title="Disconnect and forget the credential"
              className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-slate-200 bg-white text-slate-400 hover:text-rose-600 hover:border-rose-200"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-200 px-4 py-3 bg-slate-50/60">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-600">{meta.addressLabel}</label>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={status.channel === "WHATSAPP" ? "919812345678" : "service@dealership.in"}
                className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>

            {status.channel === "WHATSAPP" ? (
              <div>
                <label className="text-xs font-medium text-slate-600">Phone number ID</label>
                <input
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  placeholder="From the Meta app dashboard"
                  className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                />
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="text-xs font-medium text-slate-600">SMTP host</label>
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="smtp.dealership.in"
                    className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-600">Port</label>
                  <input
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm tabular-nums"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-slate-600">{meta.secretLabel}</label>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="new-password"
                placeholder={status.configured ? "Paste a new one to replace it" : ""}
                className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-mono"
              />
              {/* Said here rather than in a tooltip, because it is the thing
                  somebody is most likely to be uneasy about. */}
              <p className="text-[11px] text-slate-400 mt-1 leading-snug">
                Encrypted before it is stored, and no screen or API response can
                read it back — only four masked characters come back.
              </p>
            </div>

            {status.channel === "WHATSAPP" && (
              <div>
                <label className="text-xs font-medium text-slate-600">
                  App secret <span className="text-slate-400 font-normal">— for replies</span>
                </label>
                <input
                  type="password"
                  value={signing}
                  onChange={(e) => setSigning(e.target.value)}
                  autoComplete="new-password"
                  placeholder={status.canReceive ? "Leave blank to keep the saved one" : ""}
                  className="mt-1 flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-mono"
                />
                <p className="text-[11px] text-slate-400 mt-1 leading-snug">
                  Meta signs every incoming message with this. Without it the
                  dealership can send and cannot receive.
                </p>
              </div>
            )}
          </div>

          {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}

          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={save}
              disabled={!address || !secret || connect.isPending}
              className="inline-flex items-center gap-1.5 text-xs font-semibold h-8 px-3 rounded-md
                         bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {connect.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save
            </button>
            <button
              onClick={() => setOpen(false)}
              className="text-xs font-medium h-8 px-3 rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <span className="text-[11px] text-slate-400">
              Saving does not switch it on. Nothing goes out until somebody does that
              deliberately.
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Channels({ permissions }: { permissions: string[] }) {
  const { data, isLoading } = useListChannels({
    query: { queryKey: ["/api/dms/channels"] },
  })

  const maySet = permissions.includes("policy.set")

  if (isLoading) {
    return (
      <div className="py-24 flex items-center justify-center text-sm text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading…
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-16">
      <div>
        <h1 className="text-xl font-bold text-slate-900">How the dealership speaks</h1>
        <p className="text-sm text-slate-500 mt-1 max-w-2xl leading-snug">
          The accounts messages go out on, and replies come back to. They are the
          dealership's own — DDMS holds no WhatsApp number and no mail server, so
          a customer sees the number they already have saved and the bill belongs
          to whoever owns it.
        </p>
      </div>

      {!maySet && (
        <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
          <AlertTriangle className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
          <p className="text-xs text-slate-600 leading-snug">
            You can see what is connected and cannot change it. Connecting a number
            decides what this product may say to customers on the dealership's
            behalf, which is an owner's or a manager's call — the same one that
            sets the dealership's own thresholds.
          </p>
        </div>
      )}

      {(data?.channels ?? []).map((c) => (
        <ChannelCard key={c.channel} status={c} />
      ))}

      {/* The thing everybody asks second, answered where they will be looking. */}
      <div className="rounded-lg border border-slate-200 px-4 py-3">
        <h2 className="text-sm font-bold text-slate-900">What connecting does not change</h2>
        <ul className="mt-1.5 space-y-1 text-xs text-slate-600 leading-snug">
          <li>
            Every customer message still needs a named person to approve it. No rule
            can send one, whatever is connected here.
          </li>
          <li>
            The one thing that goes out unattended is an internal email to a member
            of staff about work already assigned to them.
          </li>
          <li>
            WhatsApp only accepts a free-form message within twenty-four hours of the
            customer's last one. Outside that window Meta requires a pre-approved
            template, and DDMS shows you their refusal rather than quietly sending
            something else.
          </li>
        </ul>
      </div>
    </div>
  )
}
