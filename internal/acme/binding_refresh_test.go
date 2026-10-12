package acme

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/susunola/wecert/internal/config"
	"github.com/susunola/wecert/internal/state"
)

// The page an operator is looking at is what this answers: the certificate was bound in the
// Tencent Cloud console a minute ago, and the refresh has to record it without waiting for a pass.
func TestRefreshPendingBindingsConfirmsABoundCertificate(t *testing.T) {
	dep := &fakeDeployer{bindings: 1}
	m, store, cert := newConfirmHarness(t, dep, nil)

	checked, confirmed, err := m.RefreshPendingBindings(context.Background(), true)
	if err != nil {
		t.Fatalf("refresh should not fail: %v", err)
	}
	if checked != 1 {
		t.Errorf("checked=%d, want the one pending certificate to be looked at", checked)
	}
	if len(confirmed) != 1 || confirmed[0] != cert.Name {
		t.Fatalf("confirmed=%v, want %q", confirmed, cert.Name)
	}

	got, err := store.GetCert(cert.Name)
	if err != nil {
		t.Fatal(err)
	}
	if !got.DeployConfirmed {
		t.Error("the certificate is bound, so DeployConfirmed should have been recorded")
	}
}

// Finding nothing is the normal answer for the whole time between the upload and the console bind:
// it must not be reported as a confirmation, and the certificate stays pending.
func TestRefreshPendingBindingsLeavesAnUnboundCertificatePending(t *testing.T) {
	dep := &fakeDeployer{bindings: 0}
	m, store, cert := newConfirmHarness(t, dep, nil)

	checked, confirmed, err := m.RefreshPendingBindings(context.Background(), true)
	if err != nil {
		t.Fatalf("refresh should not fail: %v", err)
	}
	if checked != 1 {
		t.Errorf("checked=%d, want the pending certificate to be looked at once", checked)
	}
	if len(confirmed) != 0 {
		t.Errorf("confirmed=%v, want nothing confirmed", confirmed)
	}

	got, err := store.GetCert(cert.Name)
	if err != nil {
		t.Fatal(err)
	}
	if got.DeployConfirmed {
		t.Error("nothing is bound, so DeployConfirmed must stay false")
	}
}

// The timer's scope: a confirmed certificate has its answer already, and one that was never uploaded
// has no cloud certificate to ask about, so neither is worth an enumeration on the interval.
func TestRefreshPendingBindingsSkipsConfirmedAndUnuploadedCertificates(t *testing.T) {
	dep := &fakeDeployer{bindings: 3}
	m, store, _ := newConfirmHarness(t, dep, func(st *state.CertState, _ *config.Certificate) {
		st.DeployConfirmed = true
	})
	if err := store.PutCert(&state.CertState{
		Name:     "never-uploaded",
		NotAfter: time.Now().Add(80 * 24 * time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	checked, confirmed, err := m.RefreshPendingBindings(context.Background(), false)
	if err != nil {
		t.Fatalf("refresh should not fail: %v", err)
	}
	if checked != 0 || len(confirmed) != 0 {
		t.Fatalf("checked=%d confirmed=%v, want nothing to look at", checked, confirmed)
	}
	if dep.calls != 0 {
		t.Errorf("Bindings ran %d times, want none: neither certificate is waiting for its first bind", dep.calls)
	}
}

// An operator's refresh re-reads the rows the page cannot render: a confirmed certificate whose
// enumeration has aged out shows "details not reported" until someone asks again, and this is that
// ask. It must not report the certificate as newly confirmed -- that answer did not change.
func TestRefreshPendingBindingsRefreshesTheRowsThePageCannotShow(t *testing.T) {
	dep := &fakeDeployer{bindings: 2}
	m, _, _ := newConfirmHarness(t, dep, func(st *state.CertState, _ *config.Certificate) {
		st.DeployConfirmed = true
	})

	checked, confirmed, err := m.RefreshPendingBindings(context.Background(), true)
	if err != nil {
		t.Fatalf("refresh should not fail: %v", err)
	}
	if checked != 1 {
		t.Errorf("checked=%d, want the confirmed certificate re-enumerated on demand", checked)
	}
	if len(confirmed) != 0 {
		t.Errorf("confirmed=%v, want no new confirmation: the flag was already set", confirmed)
	}
	if dep.calls != 1 {
		t.Errorf("Bindings ran %d times, want one enumeration to refill the rows", dep.calls)
	}
}

// The periodic caller gets the pacing and the operator gets the answer, and a forced check spends
// the window as well -- otherwise the timer would immediately re-ask what the click just asked.
func TestRefreshPendingBindingsThrottlesUnlessForced(t *testing.T) {
	dep := &fakeDeployer{bindings: 0}
	m, _, _ := newConfirmHarness(t, dep, nil)

	m.bindingCheckEvery = time.Hour
	base := time.Now()
	m.now = func() time.Time { return base }

	if _, _, err := m.RefreshPendingBindings(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if dep.calls != 1 {
		t.Fatalf("Bindings ran %d times, want the first check to run", dep.calls)
	}

	if _, _, err := m.RefreshPendingBindings(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if dep.calls != 1 {
		t.Errorf("Bindings ran %d times, want the throttled call to be skipped", dep.calls)
	}

	if _, _, err := m.RefreshPendingBindings(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if dep.calls != 2 {
		t.Errorf("Bindings ran %d times, want the forced check to run", dep.calls)
	}

	if _, _, err := m.RefreshPendingBindings(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if dep.calls != 2 {
		t.Errorf("Bindings ran %d times, want the forced check to have pushed the window out", dep.calls)
	}

	base = base.Add(2 * time.Hour)
	if _, _, err := m.RefreshPendingBindings(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if dep.calls != 3 {
		t.Errorf("Bindings ran %d times, want the check to run again once the window passed", dep.calls)
	}
}

func TestBindingRefreshCanceledContextReportsIncomplete(t *testing.T) {
	dep := &fakeDeployer{bindings: 1}
	m, _, _ := newConfirmHarness(t, dep, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	checked, confirmed, err := m.RefreshPendingBindings(ctx, true)
	if !errors.Is(err, context.Canceled) || checked != 0 || len(confirmed) != 0 || dep.calls != 0 {
		t.Fatalf("canceled refresh: checked=%d confirmed=%v err=%v calls=%d", checked, confirmed, err, dep.calls)
	}
}
