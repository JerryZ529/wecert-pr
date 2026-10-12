package acme

import (
	"context"

	"github.com/susunola/wecert/internal/deploy"
)

// RefreshPendingBindings re-asks the cloud about the certificates whose binding answer this process
// does not currently have, and records what it observed.
//
// Two kinds of candidate, and the difference is what force is for:
//
//   - a certificate waiting for its first bind: until the binding is noticed, the inventory says
//     "bind needed" for a certificate that is serving traffic, and the deployed metric reports
//     false. The daemon's ten-minute timer asks about these, and the throttle paces it.
//   - a certificate that is confirmed but whose binding rows are no longer cached: the page can then
//     show no load balancer, no name and no region, and "details not reported" is all an operator
//     sees. Only an explicit refresh asks about these -- the answer changes when someone edits the
//     load balancer in the Tencent Cloud console, so re-enumerating rows that are already displayed
//     would spend a cloud call per click for no visible change.
//
// Why this exists next to confirmBindingIfDue, which the pass already calls: the pass runs on the
// reconciliation interval (an hour by default), while the event that changes these answers is a
// person working in the Tencent Cloud console. A page re-read seconds later must not report the
// state from before their change.
//
// Read-only against the cloud: it enumerates bindings and writes what it found to the state store.
// It never binds, rebinds or deletes anything, and a certificate whose enumeration says "nothing
// bound" simply stays unconfirmed.
//
// One certificate's failure is logged and does not stop the others: the caller is a background
// timer or a page load, and one unreachable region must not silence the rest of the account.
func (m *Manager) RefreshPendingBindings(ctx context.Context, force bool) (checked int, confirmed []string, err error) {
	names, err := m.store.ListCertNames()
	if err != nil {
		return 0, nil, err
	}

	for _, name := range names {
		if err := ctx.Err(); err != nil {
			return checked, confirmed, err
		}
		st, gerr := m.store.GetCert(name)
		if gerr != nil || st == nil || st.DeployedCertID == "" {
			continue
		}

		if st.DeployConfirmed {
			// Refresh the rows the page renders, not the deployment flag: this certificate is
			// already confirmed, so there is nothing to confirm and no state to write.
			if !force {
				continue
			}
			if _, _, cached := deploy.LookupCachedBindings(st.DeployedCertID); cached {
				continue
			}
			checked++
			if _, _, berr := m.deployer.Bindings(ctx, st.DeployedCertID); berr != nil {
				if err := ctx.Err(); err != nil {
					return checked, confirmed, err
				}
				m.log.Warn("could not enumerate the bindings shown for this certificate",
					"cert", name, "certId", st.DeployedCertID, "err", berr)
			}
			continue
		}

		// Waiting for the first bind. DeployedCertID is set by the upload, which only happens when
		// the certificate's deploy is enabled, so the running configuration is not needed here to
		// tell "waiting for its first bind" from "nothing to confirm".
		if !force && !m.bindingCheckReady(name) {
			continue
		}
		m.bindingNoteAttempt(name)
		checked++

		if cerr := m.confirmBinding(ctx, name, st); cerr != nil {
			if err := ctx.Err(); err != nil {
				return checked, confirmed, err
			}
			m.log.Warn("could not confirm the certificate binding", "cert", name, "certId", st.DeployedCertID, "err", cerr)
			continue
		}
		if st.DeployConfirmed {
			confirmed = append(confirmed, name)
		}
	}
	return checked, confirmed, nil
}
