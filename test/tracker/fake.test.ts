import { contractSuite } from "./contract-suite.ts";
import { InMemoryTracker } from "../../src/tracker/fake.ts";

contractSuite("in-memory fake", () => new InMemoryTracker());
