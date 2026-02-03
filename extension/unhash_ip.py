import hashlib
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
import multiprocessing

# Target hashes to crack (extracted from the telemetry data)
TARGET_HASHES = {
    "977b6967a5717fef69c2772af31accceaa53cc73": "Device IP",
    "f2bc41c32c7265b49cfa857f24b09529a549641f": "Default Gateway/DHCP",
    "cf764b40a447e2eebf923d1c3a4b362b1a17f5ca": "PublicIP field",
    "0377858af0fb16e14b0676f189bf0466a98a08eb": "Adapter 1 IP",
    "4d417d8be419a399a654fcbc028b9fba413f33cc": "Adapter 2 IP",
    "29c4d1aff3d55774cdd2ade49e0de895072235fd": "Adapter 3 IP",
    "6df3b7bad2e09da372d2e1e69eafd67539736549": "Adapter 4 IP",
    "df8de336853f75094de716688a3e1d6ad9839d95": "Adapter 5 IP",
}

found_results = {}

def compute_hash(ip_str):
    """Compute SHA-1 hash of an IP address string."""
    return hashlib.sha1(ip_str.encode('utf-8')).hexdigest()

def crack_range(start_a, end_a, targets, target_dict=None):
    """Crack IP hashes for a range of first octets."""
    results = {}
    for a in range(start_a, end_a):
        for b in range(256):
            for c in range(256):
                for d in range(256):
                    ip = f"{a}.{b}.{c}.{d}"
                    h = hashlib.sha1(ip.encode('utf-8')).hexdigest()
                    if h in targets:
                        results[h] = ip
                        desc = target_dict.get(h, "Unknown") if target_dict else h
                        print(f"  FOUND: {ip} -> {h} ({desc})")
                        if len(results) == len(targets):
                            return results
        print(f"  Completed range {a}.x.x.x")
    return results

def main():
    print("IPv4 Hash Cracker")
    print("=" * 50)
    print(f"Target hashes to crack: {len(TARGET_HASHES)}")
    for h, desc in TARGET_HASHES.items():
        print(f"  {h}: {desc}")
    print("=" * 50)
    
    # Quick test with common private/public ranges first
    print("\nPhase 1: Checking common IP ranges first...")
    common_ranges = [
        (10, 11),      # 10.x.x.x private
        (172, 173),    # 172.x.x.x (includes 172.16-31 private)
        (192, 193),    # 192.x.x.x (includes 192.168 private)
        (1, 2),        # 1.x.x.x (Cloudflare, etc.)
        (8, 9),        # 8.x.x.x (Google, etc.)
        (20, 21),      # 20.x.x.x (Azure)
        (40, 41),      # 40.x.x.x (Azure)
        (52, 53),      # 52.x.x.x (AWS/Azure)
        (13, 14),      # 13.x.x.x (Azure)
        (104, 105),    # 104.x.x.x (Azure/Cloudflare)
        (157, 158),    # 157.x.x.x (Microsoft)
        (168, 169),    # 168-169.x.x.x
        (207, 208),    # 207.x.x.x (Microsoft)
    ]
    
    remaining = set(TARGET_HASHES.keys())
    all_results = {}
    
    for start, end in common_ranges:
        if not remaining:
            break
        print(f"  Scanning {start}.0.0.0 - {end-1}.255.255.255...")
        results = crack_range(start, end, remaining)
        all_results.update(results)
        remaining -= set(results.keys())
    
    if remaining:
        print(f"\nPhase 2: Full scan for remaining {len(remaining)} hashes...")
        print("This may take a while...")
        
        # Use multiprocessing for full scan
        num_cpus = multiprocessing.cpu_count()
        print(f"Using {num_cpus} CPU cores")
        
        # Split work into chunks of 16 first-octets each
        with ProcessPoolExecutor(max_workers=num_cpus) as executor:
            futures = []
            for start in range(0, 256, 16):
                end = min(start + 16, 256)
                futures.append(executor.submit(crack_range, start, end, remaining))
            
            for future in as_completed(futures):
                results = future.result()
                all_results.update(results)
                remaining -= set(results.keys())
                if not remaining:
                    print("All hashes cracked!")
                    break
    
    print("\n" + "=" * 50)
    print("RESULTS:")
    print("=" * 50)
    for h, desc in TARGET_HASHES.items():
        if h in all_results:
            print(f"  {desc}: {all_results[h]}")
        else:
            print(f"  {desc}: NOT FOUND (hash: {h})")

if __name__ == "__main__":
    main()