use super::*;

fn draft(name: &str, amount: &str) -> Draft {
    serde_json::from_value(json!({"name":name,"filter":{
        "itemType":"Text","appSources":[" Safari ", "Code", "Safari"],
        "favorite":"yes","relativeAmount":amount,"relativeUnit":"week"
    }}))
    .unwrap()
}

#[test]
fn filter_creation_and_edit_patch_only_the_target() {
    let first = json!({"id":"previous","name":"Previous"});
    let mut tabs = vec![first.clone()];
    let id = save_filter(&mut tabs, "", draft(" Work ", "2")).unwrap();
    assert_eq!(tabs[0], first);
    assert_eq!(tabs[1]["name"], "Work");
    assert_eq!(tabs[1]["filter"]["appSource"], "Safari");
    assert_eq!(tabs[1]["filter"]["appSources"], json!(["Safari", "Code"]));
    assert!(super::super::custom_tab_label(&tabs[1]["filter"]).contains("\"relative_amount\":2"));
    tabs[1]["filter"]["future"] = json!(7);
    assert_eq!(
        save_filter(&mut tabs, &id, draft("Updated", "")).unwrap(),
        id
    );
    assert_eq!(tabs[1]["filter"]["future"], 7);
    assert_eq!(tabs[0], first);
}

#[test]
fn invalid_and_stale_filter_edits_leave_array_unchanged() {
    let original = vec![
        json!({"id":"found","name":"Existing","filter":{"relativeAmount":"1.5","relativeUnit":"week"}}),
    ];
    for (id, value) in [("missing", "1"), ("all", "1"), ("found", "2.5"), ("", "0")] {
        let mut tabs = original.clone();
        assert!(save_filter(&mut tabs, id, draft("Changed", value)).is_err());
        assert_eq!(tabs, original);
    }
    let mut tabs = original;
    assert!(save_filter(&mut tabs, "found", draft("Renamed", "1.5")).is_ok());
}

#[test]
fn saved_sources_and_legacy_filter_options_are_loaded_without_becoming_any() {
    let legacy = json!({"appSource":"Safari","relativeAmount":4});
    let filter = Filter::from_stored(&legacy);
    assert_eq!(filter.app_sources, ["Safari"]);
    assert_eq!(filter.relative_amount, "4");
    assert_eq!(filter.relative_unit, "day");
    assert!(
        Filter::from_stored(&json!({"appSource":"Safari","appSources":[]}))
            .app_sources
            .is_empty()
    );
}

#[test]
fn record_mutations_keep_existing_id_and_only_create_selects() {
    let mut created = false;
    let result = save_record(
        "",
        " New ",
        &[],
        |name| {
            created = true;
            assert_eq!(name, "New");
            Ok(ItemTag {
                id: 9,
                name: name.into(),
            })
        },
        |_, _| unreachable!(),
    )
    .unwrap();
    assert!(created);
    assert_eq!(result.active_id.as_deref(), Some("record:9"));
    let tags = [ItemTag {
        id: 9,
        name: "New".into(),
    }];
    let renamed = save_record(
        "record:9",
        "Renamed",
        &tags,
        |_| unreachable!(),
        |id, name| {
            assert_eq!(id, 9);
            Ok(ItemTag {
                id,
                name: name.into(),
            })
        },
    )
    .unwrap();
    assert_eq!(renamed.id, "record:9");
    assert_eq!(renamed.active_id, None);
    assert!(save_record(
        "record:8",
        "Stale",
        &tags,
        |_| unreachable!(),
        |_, _| unreachable!()
    )
    .is_err());
    assert!(save_record("", " ", &tags, |_| unreachable!(), |_, _| unreachable!()).is_err());
}
