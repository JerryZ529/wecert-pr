package deploy

import (
	"encoding/json"
	"testing"

	ssl "github.com/tencentcloud/tencentcloud-sdk-go/tencentcloud/ssl/v20191205"
)

func TestParseCLBBindingItemsNamesTheListener(t *testing.T) {
	resp := decodeDetail(t, `{
		"Response": {
			"Status": 1,
			"CLB": [{
				"Region": "ap-guangzhou",
				"TotalCount": 1,
				"InstanceList": [{
					"LoadBalancerId": "lb-aaaa",
					"LoadBalancerName": "jerry",
					"Listeners": [{
						"ListenerId": "lbl-bbbb",
						"ListenerName": "test",
						"Protocol": "HTTPS",
						"Certificate": {"CertId": "cYk1"},
						"Rules": [{"Domain": "www.example.com", "Certificate": {"CertId": "cYk1"}}]
					}]
				}]
			}]
		}
	}`)
	snap := ParseCLBBindingItems(resp, "cYk1")
	if !snap.Complete || snap.Count != 1 || len(snap.Items) != 1 {
		t.Fatalf("%+v", snap)
	}
	row := snap.Items[0]
	if row.LoadBalancerID != "lb-aaaa" || row.ListenerID != "lbl-bbbb" || row.SNIDomain != "www.example.com" || row.Role != "primary" {
		t.Fatalf("%+v", row)
	}
	// The names travel with the IDs so the page can be matched against the Tencent Cloud console
	// line by line; without them an operator holding "jerry" in one console has to translate.
	if row.LoadBalancerName != "jerry" || row.ListenerName != "test" {
		t.Fatalf("cloud-side names lost: %+v", row)
	}
}

// A certificate bound to a load balancer whose listeners the service did not report still gets a
// row, and that row still carries the load balancer's identity: "which load balancer" is the
// whole content of such a row.
func TestParseCLBBindingItemsKeepsTheLoadBalancerNameWithoutListeners(t *testing.T) {
	resp := decodeDetail(t, `{
		"Response": {
			"Status": 1,
			"CLB": [{
				"Region": "ap-singapore",
				"TotalCount": 1,
				"InstanceList": [{"LoadBalancerId": "lb-hsj1v9eq", "LoadBalancerName": "jerry"}]
			}]
		}
	}`)
	snap := ParseCLBBindingItems(resp, "cYk1")
	if !snap.Complete || snap.Count != 1 || len(snap.Items) != 1 {
		t.Fatalf("%+v", snap)
	}
	row := snap.Items[0]
	if row.LoadBalancerID != "lb-hsj1v9eq" || row.LoadBalancerName != "jerry" || row.Region != "ap-singapore" {
		t.Fatalf("%+v", row)
	}
}

func TestParseCLBBindingItemsIncompleteWithoutTotalCount(t *testing.T) {
	resp := decodeDetail(t, `{
		"Response": {
			"Status": 1,
			"CLB": [{"Region": "ap-guangzhou", "InstanceList": []}]
		}
	}`)
	snap := ParseCLBBindingItems(resp, "cYk1")
	if snap.Complete {
		t.Fatalf("missing TotalCount must not be complete: %+v", snap)
	}
	if snap.Count != 0 {
		t.Fatalf("count %+v", snap)
	}
}

func TestParseCLBBindingItemsRegionErrorIsIncomplete(t *testing.T) {
	resp := decodeDetail(t, `{
		"Response": {
			"Status": 1,
			"CLB": [{"Region": "ap-guangzhou", "TotalCount": 0, "Error": "InternalError"}]
		}
	}`)
	snap := ParseCLBBindingItems(resp, "cYk1")
	if snap.Complete {
		t.Fatalf("errored region must not be complete: %+v", snap)
	}
}

func TestParseCLBBindingItemsMissingRegionIsIncomplete(t *testing.T) {
	// A finished task with no region entry answered nothing about CLB. It must
	// stay a lower bound, so the page cannot read the zero as "bound nowhere".
	resp := decodeDetail(t, `{"Response": {"Status": 1, "CLB": []}}`)
	snap := ParseCLBBindingItems(resp, "cYk1")
	if snap.Complete {
		t.Fatalf("a done task with no region entry is unanswered, not an answered zero: %+v", snap)
	}
	if snap.Count != 0 || len(snap.Items) != 0 {
		t.Fatalf("count %+v", snap)
	}
}

func TestParseCLBBindingItemsRegionZeroIsCompleteZero(t *testing.T) {
	// The answered zero: one region reported, and it reported no CLB. This is
	// the only shape that may set Complete with Count == 0.
	resp := decodeDetail(t, `{
		"Response": {
			"Status": 1,
			"CLB": [{"Region": "ap-guangzhou", "TotalCount": 0, "InstanceList": []}]
		}
	}`)
	snap := ParseCLBBindingItems(resp, "cYk1")
	if !snap.Complete || snap.Count != 0 || len(snap.Items) != 0 {
		t.Fatalf("a region entry with an empty CLB list is an answered zero: %+v", snap)
	}
}

func TestParseCLBBindingItemsNotDoneIsEmpty(t *testing.T) {
	resp := decodeDetail(t, `{"Response": {"Status": 0, "CLB": []}}`)
	snap := ParseCLBBindingItems(resp, "cYk1")
	if snap.Complete || snap.Count != 0 {
		t.Fatalf("in-flight task is not an answer: %+v", snap)
	}
}

func decodeDetail(t *testing.T, body string) *ssl.DescribeCertificateBindResourceTaskDetailResponse {
	t.Helper()
	var resp ssl.DescribeCertificateBindResourceTaskDetailResponse
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return &resp
}
