"use client";
import { Data } from "../lib/domain";
import { EntryForm } from "./Entries";

export function Receipt({ data, done }: { data: Data; done: () => void }) {
    return <EntryForm data={data} onDone={done} autoScan={true} />;
}
