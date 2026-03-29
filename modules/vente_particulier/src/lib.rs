use serde_json::json;

static mut MIGRATION_LEN: usize = 0;

#[no_mangle]
pub extern "C" fn migrate() -> i32 {
    let migration = json!({
        "entity": "vente",
        "version": 1,
        "operations": [
            {
                "type": "add_column",
                "table": "vente",
                "column": "type_client",
                "sql_type": "TEXT",
                "nullable": true
            }
        ],
        "data" : {
            "id":      "123456789",
            "amount": 24.2,
            "extensions": {
                "type_client": "particulier",
            },
        }
    });

    let s = migration.to_string();
    let bytes = s.into_bytes();
    unsafe {
        MIGRATION_LEN = bytes.len();
    }
    let ptr = bytes.as_ptr() as *mut u8;
    std::mem::forget(bytes);
    ptr as i32
}

#[no_mangle]
pub extern "C" fn migrate_len() -> i32 {
    unsafe { MIGRATION_LEN as i32 }
}
