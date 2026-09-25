import importlib.util
from pathlib import Path
import unittest

BRIDGE=Path(__file__).resolve().parents[1]/"scripts"/"wangp_bridge.py"
spec=importlib.util.spec_from_file_location("wangp_bridge",BRIDGE)
bridge=importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(bridge)

class WanGpBridgeTests(unittest.TestCase):
    def test_direct_list_model_metadata_shape(self):
        item=bridge.compact({
            "model_type":"ltx2_25_22B_distilled_nvfp4",
            "name":"LTX-2 2.5 Distilled NVFP4 22B",
            "family":"ltx2",
            "family_label":"LTX-2",
            "main_output":"video",
            "outputs":["video","audio"],
            "inputs":["text","image"],
            "capabilities":{"text_to_image":True,"image_to_image":True},
            "description":"test"
        })
        self.assertEqual(item["modelType"],"ltx2_25_22B_distilled_nvfp4")
        self.assertEqual(item["mainOutput"],["video"])
        self.assertIn("image",item["inputs"])
        self.assertTrue(item["capabilities"]["text_to_image"])

    def test_nested_metadata_shape_remains_supported(self):
        item=bridge.compact({"model_type":"x","metadata":{"outputs":"image","inputs":{"text":True}}})
        self.assertEqual(item["outputs"],["image"])
        self.assertEqual(item["inputs"],["text"])

if __name__=="__main__":
    unittest.main()
